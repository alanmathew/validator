# Manifest Lens

Manifest Lens is an offline-first browser tool for reviewing Kubernetes and OpenShift YAML/JSON manifests. It validates manifests locally and does not connect to a cluster or upload files.

## Run locally

```sh
npm install
npm run dev
```

For a static, self-contained production build:

```sh
npm run build
```

Serve the generated `dist/` directory, or open it from a local static server. The YAML parser is bundled with the app; validation itself makes no network requests.

## MVP checks

- YAML syntax, duplicate mapping keys, strict JSON syntax, invalid resource documents, and a two-space indentation style warning (without treating valid YAML indentation as a syntax error).
- Basic resource identity and key field checks for Deployment, Service, ConfigMap, Route, and Ingress.
- Deprecated/unsupported API versions relative to the selected Kubernetes or OpenShift target.
- Deployment selector/template label matching, Service selectors and named target ports, image references, structurally valid resource requests/limits with quantity checks, and health probes including handler and named-port validation.
- OpenShift warnings for workload settings that may conflict with common restricted security policies. The suggestions focus on reducing privileges and adapting workloads, not weakening cluster security.
- Local JSON report export with file, document, line, and column information.

The MVP uses focused built-in checks, not the cluster's complete admission or API schema. A clean report cannot guarantee that every cluster-specific policy will accept a manifest.
