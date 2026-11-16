import { parseAllDocuments } from "yaml";
import "./style.css";

const sample = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: nginx:1.27
          ports:
            - name: http
              containerPort: 8080
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 256Mi
          readinessProbe:
            httpGet:
              path: /
              port: http
---
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector:
    app: web
  ports:
    - name: http
      port: 80
      targetPort: http
`;

const platformSelect = document.querySelector("#platform");
const versionSelect = document.querySelector("#version");
const editor = document.querySelector("#manifest-input");
const lineNumbers = document.querySelector("#line-numbers");
const fileInput = document.querySelector("#file-input");
const activeFile = document.querySelector("#active-file");
const fileCount = document.querySelector("#file-count");
const resultsSummary = document.querySelector("#results-summary");
const resultsContent = document.querySelector("#results-content");
const validateButton = document.querySelector("#validate");
const exportButton = document.querySelector("#export-report");

let loadedFileName = "manifest.yaml";
let loadedFileContents = null;
let latestReport = null;
let diagnosticSource = "";
let diagnosticBaseOffset = 0;
let diagnosticFileName = loadedFileName;

const versionOptions = {
  kubernetes: [
    ["1.32", "Kubernetes 1.32"],
    ["1.30", "Kubernetes 1.30"],
    ["1.28", "Kubernetes 1.28"],
    ["1.26", "Kubernetes 1.26"],
    ["1.24", "Kubernetes 1.24"],
    ["1.22", "Kubernetes 1.22"],
  ],
  openshift: [
    ["4.18", "OpenShift 4.18"],
    ["4.17", "OpenShift 4.17"],
    ["4.16", "OpenShift 4.16"],
    ["4.15", "OpenShift 4.15"],
    ["4.14", "OpenShift 4.14"],
    ["4.13", "OpenShift 4.13"],
    ["4.12", "OpenShift 4.12"],
  ],
};

const openshiftKubernetesVersions = {
  "4.18": "1.31",
  "4.17": "1.30",
  "4.16": "1.29",
  "4.15": "1.28",
  "4.14": "1.27",
  "4.13": "1.26",
  "4.12": "1.25",
};

const knownApiVersions = {
  Deployment: ["apps/v1"],
  Service: ["v1"],
  ConfigMap: ["v1"],
  Route: ["route.openshift.io/v1"],
  Ingress: ["networking.k8s.io/v1"],
};

const deprecatedApiVersions = {
  "extensions/v1beta1": { removed: "1.16", resources: ["Deployment", "Ingress"] },
  "apps/v1beta1": { removed: "1.16", resources: ["Deployment"] },
  "apps/v1beta2": { removed: "1.16", resources: ["Deployment"] },
  "networking.k8s.io/v1beta1": { removed: "1.22", resources: ["Ingress"] },
};

function lineColumn(source, offset) {
  const before = source.slice(0, Math.max(0, offset));
  const lines = before.split("\n");
  return { line: lines.length, column: lines.at(-1).length + 1 };
}

function addDiagnostic(list, severity, title, detail, source, offset = 0, docIndex = 0, absoluteOffset = false) {
  const resolvedOffset = absoluteOffset ? offset : diagnosticBaseOffset + offset;
  list.push({
    severity,
    title,
    detail,
    file: diagnosticFileName,
    document: docIndex + 1,
    ...lineColumn(diagnosticSource || source, resolvedOffset),
  });
}

function getOffset(error, source, docStart) {
  if (typeof error.pos?.[0] === "number") return error.pos[0];
  if (typeof error.offset === "number") return error.offset;
  if (error.linePos?.[0]) {
    const lines = source.split("\n");
    let offset = 0;
    for (let i = 0; i < error.linePos[0].line - 1; i += 1) offset += (lines[i]?.length ?? 0) + 1;
    return offset + error.linePos[0].col - 1;
  }
  return docStart;
}

function getTarget() {
  const platform = platformSelect.value;
  const version = versionSelect.value;
  return {
    platform,
    version,
    kubernetesVersion: platform === "openshift" ? openshiftKubernetesVersions[version] : version,
  };
}

function pathValue(object, path) {
  return path.split(".").reduce((value, part) => value?.[part], object);
}

function valueOffset(source, value) {
  if (typeof value !== "string" || !value) return 0;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:"${escaped}"|'${escaped}'|${escaped})`).exec(source);
  return match?.index ?? 0;
}

function keyOffset(source, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.match(new RegExp(`^[ \\t]*${escaped}[ \\t]*:`, "m"))?.index ?? 0;
}

function isValidResourceQuantity(value) {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0;
  if (typeof value !== "string") return false;
  return /^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+|[numkKMGTP]|[KMGTPE]i)?$/.test(value);
}

function validateResourceRequirements(container, source, diagnostics, docIndex, containerOffset) {
  const resources = container.resources;
  if (resources === undefined) {
    addDiagnostic(diagnostics, "warning", "Resource requests or limits are missing", "Set resources.requests and resources.limits so the scheduler can place the pod and the container has an explicit resource boundary.", source, containerOffset, docIndex);
    return;
  }
  if (!resources || typeof resources !== "object" || Array.isArray(resources)) {
    addDiagnostic(diagnostics, "error", "Invalid resources field", "container.resources must be a mapping with optional requests and limits mappings.", source, keyOffset(source, "resources"), docIndex);
    return;
  }

  for (const key of Object.keys(resources)) {
    if (key !== "requests" && key !== "limits") {
      addDiagnostic(diagnostics, "error", `Unexpected resources field "${key}"`, `Place resource quantities such as ${key} under resources.requests or resources.limits.`, source, keyOffset(source, key), docIndex);
    }
  }

  for (const field of ["requests", "limits"]) {
    const quantities = resources[field];
    if (quantities === undefined) {
      addDiagnostic(diagnostics, "warning", `Resource ${field} are missing`, `Add resources.${field} as a mapping of resource names to quantities (for example, cpu: 100m and memory: 128Mi).`, source, keyOffset(source, "resources"), docIndex);
      continue;
    }
    if (!quantities || typeof quantities !== "object" || Array.isArray(quantities)) {
      addDiagnostic(diagnostics, "error", `Invalid resources.${field}`, `resources.${field} must be a non-empty mapping of resource names to quantities; it cannot be empty or null.`, source, keyOffset(source, field), docIndex);
      continue;
    }
    if (!Object.keys(quantities).length) {
      addDiagnostic(diagnostics, "error", `Empty resources.${field}`, `Add at least one resource quantity under resources.${field}, such as cpu: 100m or memory: 128Mi.`, source, keyOffset(source, field), docIndex);
      continue;
    }
    for (const [name, quantity] of Object.entries(quantities)) {
      if (!isValidResourceQuantity(quantity)) {
        addDiagnostic(diagnostics, "error", `Invalid ${field} quantity for ${name}`, "Use a non-negative Kubernetes resource quantity, such as cpu: 100m or memory: 128Mi.", source, keyOffset(source, name), docIndex);
      }
    }
  }
}

function validateProbe(probe, probeName, container, source, diagnostics, docIndex) {
  const offset = keyOffset(source, probeName);
  if (!probe || typeof probe !== "object" || Array.isArray(probe)) {
    addDiagnostic(diagnostics, "error", `Invalid ${probeName}`, `${probeName} must be a mapping with exactly one handler: httpGet, tcpSocket, exec, or grpc.`, source, offset, docIndex);
    return;
  }

  const handlers = ["httpGet", "tcpSocket", "exec", "grpc"].filter((key) => probe[key] !== undefined);
  if (handlers.length !== 1) {
    addDiagnostic(diagnostics, "error", `Invalid ${probeName} handler`, `Provide exactly one ${probeName} handler: httpGet, tcpSocket, exec, or grpc.`, source, offset, docIndex);
    return;
  }

  const handlerName = handlers[0];
  const handler = probe[handlerName];
  if (!handler || typeof handler !== "object" || Array.isArray(handler)) {
    addDiagnostic(diagnostics, "error", `Invalid ${probeName}.${handlerName}`, `${probeName}.${handlerName} must be a mapping.`, source, keyOffset(source, handlerName), docIndex);
    return;
  }

  if (handlerName === "httpGet" || handlerName === "tcpSocket") {
    const port = handler.port;
    if (typeof port === "number") {
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        addDiagnostic(diagnostics, "error", `Invalid ${probeName} port`, "Probe port must be an integer from 1 to 65535.", source, keyOffset(source, "port"), docIndex);
      }
    } else if (typeof port === "string" && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(port)) {
      const declared = (Array.isArray(container.ports) ? container.ports : []).some((item) => item?.name === port);
      if (!declared) {
        addDiagnostic(diagnostics, "error", `Unknown named port in ${probeName}`, `No port named "${port}" is declared in this container's ports list. Declare the named container port or use its numeric port.`, source, valueOffset(source, port), docIndex);
      }
    } else {
      addDiagnostic(diagnostics, "error", `Missing or invalid ${probeName} port`, "Set the probe port to a number from 1 to 65535 or a valid name declared in this container's ports list.", source, keyOffset(source, handlerName), docIndex);
    }
    if (handlerName === "httpGet" && handler.path !== undefined && typeof handler.path !== "string") {
      addDiagnostic(diagnostics, "error", `Invalid ${probeName} path`, "httpGet.path must be a string.", source, keyOffset(source, "path"), docIndex);
    }
  }

  if (handlerName === "grpc" && (!Number.isInteger(handler.port) || handler.port < 1 || handler.port > 65535)) {
    addDiagnostic(diagnostics, "error", `Invalid ${probeName} gRPC port`, "grpc.port must be an integer from 1 to 65535.", source, keyOffset(source, "grpc"), docIndex);
  }
  for (const field of ["initialDelaySeconds", "timeoutSeconds", "periodSeconds", "successThreshold", "failureThreshold"]) {
    if (probe[field] !== undefined && (!Number.isInteger(probe[field]) || probe[field] < (field === "initialDelaySeconds" ? 0 : 1))) {
      addDiagnostic(diagnostics, "error", `Invalid ${probeName}.${field}`, `${probeName}.${field} must be an integer >= ${field === "initialDelaySeconds" ? 0 : 1}.`, source, keyOffset(source, field), docIndex);
    }
  }
}

function validateImage(image) {
  if (typeof image !== "string" || !image.trim()) return "Image reference is required.";
  if (/\s|:\/\/|[A-Z]/.test(image)) return "Use a valid OCI image reference (lowercase name, optional tag or sha256 digest).";
  const pattern = /^(?:(?:[a-z0-9.-]+(?::[0-9]+)?\/))?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;
  return pattern.test(image) ? null : "Use a valid OCI image reference (for example, registry.example.com/team/app:1.2).";
}

function checkOpenShiftSecurity(podSpec, source, diagnostics, docIndex) {
  const containers = [
    ...(Array.isArray(podSpec.containers) ? podSpec.containers : []),
    ...(Array.isArray(podSpec.initContainers) ? podSpec.initContainers : []),
  ];
  const allSecurityContexts = [
    podSpec.securityContext,
    ...containers.map((container) => container.securityContext),
  ].filter(Boolean);

  if (podSpec.hostNetwork === true || podSpec.hostPID === true || podSpec.hostIPC === true) {
    addDiagnostic(
      diagnostics,
      "warning",
      "Host namespace access may be restricted",
      "OpenShift security policies commonly restrict host networking and host PID/IPC namespaces. Confirm the workload is compatible with the cluster’s assigned security policy; avoid relying on elevated host access.",
      source,
      valueOffset(source, "hostNetwork") || valueOffset(source, "hostPID") || valueOffset(source, "hostIPC"),
      docIndex,
    );
  }

  for (const context of allSecurityContexts) {
    if (context.privileged === true) {
      addDiagnostic(diagnostics, "warning", "Privileged container may be rejected", "OpenShift security policies commonly disallow privileged containers. Remove the privileged requirement or redesign the workload to use a restricted security context.", source, valueOffset(source, "privileged"), docIndex);
    }
    if (context.runAsUser === 0 || context.runAsNonRoot === false) {
      addDiagnostic(diagnostics, "warning", "Container may require root access", "OpenShift commonly assigns a restricted non-root UID. Make the image writable and runnable with an arbitrary non-root UID rather than requiring root.", source, valueOffset(source, context.runAsUser === 0 ? "runAsUser" : "runAsNonRoot"), docIndex);
    }
    if (context.allowPrivilegeEscalation === true) {
      addDiagnostic(diagnostics, "warning", "Privilege escalation is enabled", "OpenShift security policies may reject privilege escalation. Set allowPrivilegeEscalation to false and verify the application works without escalating privileges.", source, valueOffset(source, "allowPrivilegeEscalation"), docIndex);
    }
    if (context.capabilities?.add?.length) {
      addDiagnostic(diagnostics, "warning", "Additional Linux capabilities may be restricted", "OpenShift security policies may reject added capabilities. Remove unneeded capabilities and use the minimum permissions required by the workload.", source, valueOffset(source, "capabilities"), docIndex);
    }
  }

  if (Array.isArray(podSpec.volumes) && podSpec.volumes.some((volume) => volume?.hostPath)) {
    addDiagnostic(diagnostics, "warning", "hostPath volume may be restricted", "OpenShift policies commonly restrict host filesystem access. Prefer a supported persistent volume or another workload-appropriate storage type.", source, valueOffset(source, "hostPath"), docIndex);
  }
}

function validatePodTemplate(resource, source, diagnostics, docIndex, target) {
  const podSpec = resource.spec?.template?.spec;
  const labels = resource.spec?.template?.metadata?.labels ?? {};
  const selector = resource.spec?.selector?.matchLabels;

  if (!podSpec || typeof podSpec !== "object") {
    addDiagnostic(diagnostics, "error", "Missing pod template spec", "Provide spec.template.spec with at least one container.", source, valueOffset(source, "template"), docIndex);
    return { labels, containers: [], podSpec: {} };
  }
  if (!Array.isArray(podSpec.containers) || podSpec.containers.length === 0) {
    addDiagnostic(diagnostics, "error", "No containers defined", "Add at least one container under spec.template.spec.containers.", source, valueOffset(source, "containers"), docIndex);
  }
  if (podSpec.initContainers !== undefined && !Array.isArray(podSpec.initContainers)) {
    addDiagnostic(diagnostics, "error", "Invalid initContainers field", "spec.template.spec.initContainers must be a list of container objects.", source, valueOffset(source, "initContainers"), docIndex);
  }
  if (podSpec.volumes !== undefined && !Array.isArray(podSpec.volumes)) {
    addDiagnostic(diagnostics, "error", "Invalid volumes field", "spec.template.spec.volumes must be a list of volume objects.", source, valueOffset(source, "volumes"), docIndex);
  }
  if (!selector || typeof selector !== "object" || Object.keys(selector).length === 0) {
    addDiagnostic(diagnostics, "error", "Missing Deployment selector", "Set spec.selector.matchLabels to a non-empty set of labels.", source, valueOffset(source, "selector"), docIndex);
  } else if (!Object.entries(selector).every(([key, value]) => labels[key] === value)) {
    addDiagnostic(diagnostics, "error", "Selector does not match pod labels", "Every spec.selector.matchLabels entry must have the same value in spec.template.metadata.labels.", source, valueOffset(source, "matchLabels"), docIndex);
  }

  const containers = [
    ...(Array.isArray(podSpec.containers) ? podSpec.containers : []),
    ...(Array.isArray(podSpec.initContainers) ? podSpec.initContainers : []),
  ];
  for (const container of containers) {
    if (!container || typeof container !== "object" || Array.isArray(container)) {
      addDiagnostic(diagnostics, "error", "Invalid container definition", "Each container entry must be an object with a name and image.", source, valueOffset(source, "containers"), docIndex);
      continue;
    }
    const containerOffset = valueOffset(source, container.name);
    if (!container.name) addDiagnostic(diagnostics, "error", "Container name is required", "Give each container a unique name.", source, valueOffset(source, "containers"), docIndex);
    const imageIssue = validateImage(container.image);
    if (imageIssue) addDiagnostic(diagnostics, "error", "Invalid container image", imageIssue, source, containerOffset || valueOffset(source, "image"), docIndex);

    validateResourceRequirements(container, source, diagnostics, docIndex, containerOffset || valueOffset(source, "resources"));
    if (!container.readinessProbe && !container.livenessProbe && !container.startupProbe) {
      addDiagnostic(diagnostics, "warning", "No health probe configured", "Add a readiness probe to control traffic, and a liveness or startup probe when the application needs health-based recovery.", source, containerOffset || valueOffset(source, "containers"), docIndex);
    }
    for (const probeName of ["readinessProbe", "livenessProbe", "startupProbe"]) {
      if (container[probeName] !== undefined) validateProbe(container[probeName], probeName, container, source, diagnostics, docIndex);
    }
    if (container.ports !== undefined && !Array.isArray(container.ports)) {
      addDiagnostic(diagnostics, "error", "Invalid container ports field", "container.ports must be a list of port objects.", source, valueOffset(source, "ports"), docIndex);
    }
    for (const port of Array.isArray(container.ports) ? container.ports : []) {
      if (!port || typeof port !== "object" || Array.isArray(port)) {
        addDiagnostic(diagnostics, "error", "Invalid container port entry", "Each container port must be an object with a valid containerPort number.", source, valueOffset(source, "ports"), docIndex);
        continue;
      }
      if (!Number.isInteger(port.containerPort) || port.containerPort < 1 || port.containerPort > 65535) {
        addDiagnostic(diagnostics, "error", "Invalid container port", "containerPort must be an integer from 1 to 65535.", source, valueOffset(source, "containerPort"), docIndex);
      }
    }
  }
  if (target.platform === "openshift") checkOpenShiftSecurity(podSpec, source, diagnostics, docIndex);
  return { labels, containers: podSpec.containers ?? [], podSpec };
}

function validateResource(resource, source, diagnostics, docIndex, target) {
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
    addDiagnostic(diagnostics, "error", "Document is not a resource object", "Each non-empty YAML/JSON document must contain a Kubernetes resource object.", source, 0, docIndex);
    return null;
  }

  const { apiVersion, kind } = resource;
  if (!apiVersion || !kind) {
    addDiagnostic(diagnostics, "error", "Missing resource identity", "Set both apiVersion and kind at the top level of the resource.", source, 0, docIndex);
    return null;
  }

  const supportedVersions = knownApiVersions[kind];
  if (!supportedVersions) {
    addDiagnostic(diagnostics, "warning", `Resource kind ${kind} is outside MVP coverage`, "This validator checks Deployment, Service, ConfigMap, Route, and Ingress; verify this resource against the cluster’s full API schema.", source, valueOffset(source, kind), docIndex);
  } else if (!supportedVersions.includes(apiVersion)) {
    const deprecated = deprecatedApiVersions[apiVersion];
    if (deprecated?.resources.includes(kind)) {
      const currentVersion = Number(target.kubernetesVersion.split(".")[1]);
      const removedVersion = Number(deprecated.removed.split(".")[1]);
      const message = currentVersion >= removedVersion
        ? `${apiVersion} was removed in Kubernetes ${deprecated.removed} and is not accepted by this target.`
        : `${apiVersion} is deprecated and will be removed in Kubernetes ${deprecated.removed}.`;
      addDiagnostic(diagnostics, currentVersion >= removedVersion ? "error" : "warning", `Incompatible API version for ${kind}`, `${message} Migrate to ${supportedVersions.join(" or ")}.`, source, valueOffset(source, apiVersion), docIndex);
    } else {
      addDiagnostic(diagnostics, "error", `Unsupported API version for ${kind}`, `Use ${supportedVersions.join(" or ")} for ${kind}.`, source, valueOffset(source, apiVersion), docIndex);
    }
  }

  if (kind === "Route" && target.platform !== "openshift") {
    addDiagnostic(diagnostics, "error", "Route requires OpenShift", "Route is an OpenShift API resource and is not available on a Kubernetes target. Select OpenShift or use an Ingress.", source, valueOffset(source, kind), docIndex);
  }

  if (!resource.metadata || typeof resource.metadata !== "object" || !resource.metadata.name) {
    addDiagnostic(diagnostics, "error", "Resource name is required", "Set metadata.name to a non-empty string.", source, valueOffset(source, "metadata"), docIndex);
  }

  switch (kind) {
    case "Deployment": {
      if (!resource.spec || typeof resource.spec !== "object") addDiagnostic(diagnostics, "error", "Deployment spec is required", "Add spec with selector and pod template fields.", source, valueOffset(source, "spec"), docIndex);
      if (resource.spec?.replicas !== undefined && (!Number.isInteger(resource.spec.replicas) || resource.spec.replicas < 0)) addDiagnostic(diagnostics, "error", "Invalid replica count", "spec.replicas must be a non-negative integer.", source, valueOffset(source, "replicas"), docIndex);
      const workload = validatePodTemplate(resource, source, diagnostics, docIndex, target);
      return { kind, labels: workload.labels, containers: workload.containers, metadata: resource.metadata };
    }
    case "Service": {
      const spec = resource.spec;
      if (!spec || typeof spec !== "object") addDiagnostic(diagnostics, "error", "Service spec is required", "Add a Service spec with ports and, unless this is an ExternalName service, a selector.", source, valueOffset(source, "spec"), docIndex);
      if (spec && spec.type !== "ExternalName" && (!spec.selector || !Object.keys(spec.selector).length)) addDiagnostic(diagnostics, "warning", "Service has no pod selector", "Add spec.selector to route traffic to matching pods, or verify that this is an intentional selectorless Service.", source, valueOffset(source, "selector"), docIndex);
      if (spec?.type !== "ExternalName" && (!Array.isArray(spec?.ports) || !spec.ports.length)) addDiagnostic(diagnostics, "error", "Service ports are required", "Add at least one entry under spec.ports.", source, valueOffset(source, "ports"), docIndex);
      for (const port of Array.isArray(spec?.ports) ? spec.ports : []) {
        if (!port || typeof port !== "object" || Array.isArray(port)) {
          addDiagnostic(diagnostics, "error", "Invalid Service port entry", "Each Service port must be an object with a valid port number.", source, valueOffset(source, "ports"), docIndex);
          continue;
        }
        if (!Number.isInteger(port.port) || port.port < 1 || port.port > 65535) addDiagnostic(diagnostics, "error", "Invalid Service port", "port must be an integer from 1 to 65535.", source, valueOffset(source, "port"), docIndex);
        if (typeof port.targetPort === "number" && (port.targetPort < 1 || port.targetPort > 65535)) addDiagnostic(diagnostics, "error", "Invalid Service targetPort", "A numeric targetPort must be from 1 to 65535.", source, valueOffset(source, "targetPort"), docIndex);
        if (typeof port.targetPort === "string" && !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(port.targetPort)) addDiagnostic(diagnostics, "error", "Invalid named targetPort", "Named targetPort values must be valid port names (lowercase alphanumeric characters and hyphens).", source, valueOffset(source, "targetPort"), docIndex);
      }
      return { kind, selector: spec?.selector, ports: spec?.ports ?? [], metadata: resource.metadata };
    }
    case "ConfigMap": {
      if (resource.data !== undefined && (!resource.data || typeof resource.data !== "object" || Array.isArray(resource.data) || Object.values(resource.data).some((value) => typeof value !== "string"))) addDiagnostic(diagnostics, "error", "Invalid ConfigMap data", "ConfigMap data must be a map of string keys to string values.", source, valueOffset(source, "data"), docIndex);
      break;
    }
    case "Route":
      if (!resource.spec?.to?.name) addDiagnostic(diagnostics, "error", "Route target is required", "Set spec.to.kind and spec.to.name to identify the backend Service.", source, valueOffset(source, "to"), docIndex);
      break;
    case "Ingress":
      if (!resource.spec || typeof resource.spec !== "object") addDiagnostic(diagnostics, "error", "Ingress spec is required", "Add an Ingress spec with rules, a default backend, or a TLS configuration.", source, valueOffset(source, "spec"), docIndex);
      if (resource.spec && !resource.spec.rules?.length && !resource.spec.defaultBackend) addDiagnostic(diagnostics, "warning", "Ingress has no routing rules", "Add spec.rules or spec.defaultBackend to route requests.", source, valueOffset(source, "rules"), docIndex);
      break;
    default:
      break;
  }
  return { kind, metadata: resource.metadata };
}

function validateCrossResourceReferences(resources, diagnostics) {
  const deployments = resources.filter((resource) => resource?.kind === "Deployment");
  const services = resources.filter((resource) => resource?.kind === "Service" && resource.selector && Object.keys(resource.selector).length);
  if (!deployments.length) return;

  for (const service of services) {
    const matchingDeployments = deployments.filter((deployment) =>
      Object.entries(service.selector).every(([key, value]) => deployment.labels?.[key] === value),
    );
    if (!matchingDeployments.length) {
      diagnosticSource = service.fullSource;
      diagnosticBaseOffset = service.docStart;
      diagnosticFileName = service.file;
      addDiagnostic(diagnostics, "warning", "Service selector matches no Deployment in these documents", "Check that the Service selector uses the same labels as a Deployment’s pod template. If its pods are defined elsewhere, verify the labels there.", service.source, valueOffset(service.source, service.metadata?.name), service.document);
      continue;
    }
    for (const port of service.ports ?? []) {
      if (typeof port.targetPort !== "string") continue;
      const found = matchingDeployments.some((deployment) =>
        deployment.containers.some((container) => container.ports?.some((containerPort) => containerPort.name === port.targetPort)),
      );
      if (!found) {
        diagnosticSource = service.fullSource;
        diagnosticBaseOffset = service.docStart;
        diagnosticFileName = service.file;
        addDiagnostic(diagnostics, "error", "Service targetPort does not match a container port", `No matching Deployment container declares a port named "${port.targetPort}". Use a declared port name or a valid numeric targetPort.`, service.source, valueOffset(service.source, port.targetPort), service.document);
      }
    }
  }
}

function jsonSyntaxError(source, error, diagnostics) {
  const match = /position\s+(\d+)/i.exec(error.message);
  const offset = match ? Number(match[1]) : 0;
  addDiagnostic(diagnostics, "error", "Invalid JSON syntax", error.message, source, offset, 0);
}

function splitDocumentOffsets(source, docs) {
  return docs.map((doc) => doc.range?.[0] ?? 0);
}

function validateIndentationStyle(source, diagnostics) {
  let offset = 0;
  let blockScalarIndent = null;
  for (const line of source.split("\n")) {
    const indentation = line.match(/^ */)[0].length;
    const content = line.slice(indentation);
    if (!content.trim() || content.startsWith("#")) {
      offset += line.length + 1;
      continue;
    }

    if (blockScalarIndent !== null) {
      if (indentation > blockScalarIndent) {
        offset += line.length + 1;
        continue;
      }
      blockScalarIndent = null;
    }

    if (indentation % 2 !== 0) {
      addDiagnostic(
        diagnostics,
        "warning",
        "Non-standard YAML indentation",
        "This YAML is parseable, but this line uses an odd number of leading spaces. Use consistent two-space indentation to make nesting easier to read and review.",
        source,
        offset,
        0,
        true,
      );
    }

    if (/(?:^|:\s+|-\s+)[|>][+-]?\d?\s*(?:#.*)?$/.test(content)) {
      blockScalarIndent = indentation;
    }
    offset += line.length + 1;
  }
}

function validateSource(source, fileName = loadedFileName) {
  const diagnostics = [];
  diagnosticSource = source;
  diagnosticBaseOffset = 0;
  diagnosticFileName = fileName;
  const trimmed = source.trim();
  if (!trimmed) {
    addDiagnostic(diagnostics, "error", "No manifest content", "Paste YAML/JSON or open one or more manifest files to validate.", source);
    return { diagnostics, resources: [] };
  }

  const looksLikeJson = /^[{[]/.test(trimmed);
  const isJson = fileName.toLowerCase().endsWith(".json") || looksLikeJson;
  if (!isJson) validateIndentationStyle(source, diagnostics);
  if (isJson) {
    try {
      JSON.parse(source);
    } catch (error) {
      jsonSyntaxError(source, error, diagnostics);
      return { diagnostics, resources: [] };
    }
  }

  let docs;
  try {
    docs = parseAllDocuments(source, { uniqueKeys: true, strict: true, prettyErrors: true });
  } catch (error) {
    addDiagnostic(diagnostics, "error", "Unable to parse manifest", error.message, source, error.pos?.[0] ?? 0);
    return { diagnostics, resources: [] };
  }

  const docOffsets = splitDocumentOffsets(source, docs);
  const resources = [];
  const target = getTarget();
  docs.forEach((doc, index) => {
    diagnosticBaseOffset = 0;
    for (const error of doc.errors) {
      addDiagnostic(diagnostics, "error", "Invalid YAML syntax or duplicate key", error.message, source, getOffset(error, source, docOffsets[index] ?? 0), index, true);
    }
    for (const warning of doc.warnings) {
      addDiagnostic(diagnostics, "warning", "YAML parsing warning", warning.message, source, getOffset(warning, source, docOffsets[index] ?? 0), index, true);
    }
    if (doc.errors.length) return;
    if (doc.contents === null) return;
    let resource;
    try {
      resource = doc.toJS({ maxAliasCount: 50 });
    } catch (error) {
      addDiagnostic(diagnostics, "error", "Invalid YAML document", error.message, source, docOffsets[index] ?? 0, index, true);
      return;
    }
    diagnosticBaseOffset = docOffsets[index] ?? 0;
    const docSource = doc.toString();
    const hasManifestIdentity = resource && typeof resource === "object" && !Array.isArray(resource)
      && ("apiVersion" in resource || "kind" in resource);
    if (isJson && !hasManifestIdentity) {
      addDiagnostic(diagnostics, "info", "Valid JSON, not a Kubernetes manifest", "JSON syntax is valid. This document has no apiVersion or kind, so manifest schema checks were skipped.", docSource, 0, index);
      return;
    }
    const found = validateResource(resource, docSource, diagnostics, index, target);
    if (found) {
      found.source = docSource;
      found.fullSource = source;
      found.docStart = diagnosticBaseOffset;
      found.file = fileName;
      found.document = index;
      resources.push(found);
    }
  });
  diagnosticBaseOffset = 0;
  return { diagnostics, resources };
}

function renderDiagnostics(diagnostics) {
  resultsContent.replaceChildren();
  if (!diagnostics.length) {
    resultsContent.innerHTML = '<div class="success-banner">✓ No issues found. These manifests passed the checks available for the selected target.</div>';
    return;
  }
  const list = document.createElement("div");
  list.className = "diagnostic-list";
  for (const item of diagnostics) {
    const row = document.createElement("article");
    row.className = "diagnostic";
    const severity = document.createElement("span");
    severity.className = `severity severity-${item.severity}`;
    severity.textContent = item.severity;
    const body = document.createElement("div");
    const title = document.createElement("p");
    title.className = "diagnostic-title";
    title.textContent = item.title;
    const detail = document.createElement("p");
    detail.className = "diagnostic-detail";
    detail.textContent = item.detail;
    const meta = document.createElement("div");
    meta.className = "diagnostic-meta";
    const location = document.createElement("span");
    location.textContent = `${item.file} · document ${item.document} · line ${item.line}, column ${item.column}`;
    meta.append(location);
    if (!loadedFileContents || loadedFileContents.length === 1) {
      const jump = document.createElement("a");
      jump.href = "#manifest-input";
      jump.textContent = "Go to line";
      jump.addEventListener("click", (event) => {
        event.preventDefault();
        const lines = editor.value.split("\n");
        const start = lines.slice(0, item.line - 1).reduce((total, line) => total + line.length + 1, 0);
        editor.focus();
        editor.setSelectionRange(start, start + (lines[item.line - 1]?.length ?? 0));
        editor.scrollTop = Math.max(0, (item.line - 5) * 20);
      });
      meta.append(jump);
    }
    body.append(title, detail, meta);
    row.append(severity, body);
    list.append(row);
  }
  resultsContent.append(list);
}

function renderSummary(errors, warnings, infos, targetLabel, hasIssues) {
  resultsSummary.replaceChildren();
  if (!hasIssues) {
    resultsSummary.textContent = `No issues found · ${targetLabel}`;
    return;
  }
  const errorChip = document.createElement("span");
  errorChip.className = "summary-chip summary-error";
  errorChip.textContent = `${errors} ${errors === 1 ? "error" : "errors"}`;
  const warningChip = document.createElement("span");
  warningChip.className = "summary-chip summary-warning";
  warningChip.textContent = `${warnings} ${warnings === 1 ? "warning" : "warnings"}`;
  const infoChip = document.createElement("span");
  infoChip.className = "summary-chip summary-info";
  infoChip.textContent = `${infos} ${infos === 1 ? "info" : "infos"}`;
  const target = document.createElement("span");
  target.className = "summary-target";
  target.textContent = targetLabel;
  resultsSummary.append(errorChip, warningChip);
  if (infos) resultsSummary.append(infoChip);
  resultsSummary.append(target);
}

function updateLineNumbers() {
  const count = editor.value.split("\n").length;
  lineNumbers.textContent = Array.from({ length: count }, (_, index) => index + 1).join("\n");
  lineNumbers.scrollTop = editor.scrollTop;
  if (loadedFileContents?.length > 1) {
    fileCount.textContent = `${loadedFileContents.length} files`;
    return;
  }
  const documents = editor.value.split(/^---\s*$/m).filter((part) => part.trim()).length;
  const format = loadedFileName.toLowerCase().endsWith(".json") ? "JSON" : "YAML";
  fileCount.textContent = `${documents} ${documents === 1 ? "document" : "documents"} · ${format}`;
}

function runValidation() {
  const fileResults = loadedFileContents
    ? loadedFileContents.map((file) => validateSource(file.contents, file.name))
    : [validateSource(editor.value, loadedFileName)];
  const diagnostics = fileResults.flatMap((result) => result.diagnostics);
  const resources = fileResults.flatMap((result) => result.resources);
  validateCrossResourceReferences(resources, diagnostics);
  const errors = diagnostics.filter((item) => item.severity === "error").length;
  const warnings = diagnostics.filter((item) => item.severity === "warning").length;
  const infos = diagnostics.filter((item) => item.severity === "info").length;
  const target = getTarget();
  const targetLabel = target.platform === "openshift" ? `OpenShift ${target.version}` : `Kubernetes ${target.version}`;
  renderSummary(errors, warnings, infos, targetLabel, diagnostics.length > 0);
  latestReport = {
    generatedAt: new Date().toISOString(),
    target: targetLabel,
    file: loadedFileName,
    summary: { errors, warnings, total: diagnostics.length },
    diagnostics,
  };
  renderDiagnostics(diagnostics);
  exportButton.disabled = false;
}

function updateVersions() {
  const versions = versionOptions[platformSelect.value];
  versionSelect.replaceChildren(...versions.map(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    return option;
  }));
}

platformSelect.addEventListener("change", updateVersions);
editor.addEventListener("input", updateLineNumbers);
editor.addEventListener("input", () => {
  if (loadedFileContents?.length > 1) {
    loadedFileName = "manifest.yaml";
    activeFile.textContent = loadedFileName;
  }
  loadedFileContents = null;
});
editor.addEventListener("scroll", () => { lineNumbers.scrollTop = editor.scrollTop; });
document.querySelector("#open-files").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  const files = Array.from(fileInput.files ?? []);
  if (!files.length) return;
  loadedFileContents = await Promise.all(files.map(async (file) => ({ name: file.name, contents: await file.text() })));
  loadedFileName = files.length === 1 ? files[0].name : `${files.length} files`;
  activeFile.textContent = loadedFileName;
  editor.value = loadedFileContents.map((file) => file.contents).join("\n---\n");
  latestReport = null;
  exportButton.disabled = true;
  resultsSummary.textContent = "Files loaded. Run validation to see what needs attention.";
  resultsContent.innerHTML = '<div class="empty-state"><span class="empty-icon" aria-hidden="true">⌁</span><span>Your results will appear here.</span></div>';
  updateLineNumbers();
  fileInput.value = "";
});
validateButton.addEventListener("click", runValidation);
exportButton.addEventListener("click", () => {
  if (!latestReport) return;
  const blob = new Blob([JSON.stringify(latestReport, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "manifest-validation-report.json";
  link.click();
  URL.revokeObjectURL(url);
});

updateVersions();
editor.value = sample;
updateLineNumbers();
