# SoapUI / ReadyAPI projects — `soapui`

Fixtures for **FMT-10.3** ([#5477](https://github.com/apiome/apiome/issues/5477)). A SoapUI project is
where SOAP estates keep their request corpus, assertions and test suites — the exact estates Apiome's
WSDL, XSD and z/OS Connect support already serves — and it is SmartBear's own format, so reading it is
a direct migration path off a competitor. Entries carry `adapter_key: null` and the `pending-adapter`
tag.

**Detection marker.** Root element `soapui-project` in the `http://eviware.com/soapui/config`
namespace (conventionally the `con:` prefix).

**What the adapter takes**

| SoapUI | Canonical |
| --- | --- |
| `interface` `xsi:type="con:WsdlInterface"` | **delegate to the WSDL adapter** — full schema fidelity, must match its goldens |
| `interface` `xsi:type="con:RestService"` | resources/methods → operations; bodies via the inferred-spec engine (**#4387**) |
| `resource` `path` + `method` `method` | operation path and verb |
| `parameter` `style` (`QUERY`, `TEMPLATE`, `HEADER`, `MATRIX`) | parameter location |
| `endpoints` / `environments` | servers |
| `testSuite` / `testCase` / `testStep` / `assertion` | **declared test intent**, cross-linking the contract-testing roadmap |
| `restMockService` responses | example responses |
| `credentials` | scrubbed — never persisted |

| File | Rung | What it exercises |
| --- | --- | --- |
| `01-minimal-project.xml` | minimal | One REST interface, one resource, one GET. |
| `02-typical-rest-project.xml` | typical | Two resources, `QUERY` and `TEMPLATE` parameters, request/response representations, two endpoints, a project property. |
| `03-wsdl-set/` | multi-file | A WSDL-backed interface whose `definition` is a **local file** — schema fidelity only exists across the set. |
| `04-stress-test-suites.xml` | stress | Test suites and cases with `restrequest`, `transfer`, `delay`, `groovy`, `datasource` and `datasourceloop` steps, and four assertion kinds. |
| `05-real-world-soap-project.xml` | real-world | A legacy SOAP project: WSDL interface with request-response and one-way operations, saved envelopes, WS-Security credentials by property, two environments, a smoke suite. |
| `06-typical-mock-service.xml` | typical | A REST mock service with two canned responses and a dispatch style. |
| `07-composition-shared-endpoints.xml` | composition | Two interfaces sharing endpoints through project properties, and a test case that spans both. |
| `negative/` | — | Unclosed interface, a project with no interfaces, truncation, a bare **WSDL**, UTF-16, and an interface whose `definition` file is missing. |

**Credential rule.** Passwords are empty or `${#Project#...}` references; FMT-10.3 requires saved
credentials to be scrubbed and never persisted, and the fixtures carry nothing to leak.
