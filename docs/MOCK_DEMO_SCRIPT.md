# First Mock Run — demo script

A live walkthrough for someone who has never touched the mock. Import an OpenAPI spec, switch the
mock on, and then earn the two moments that matter: the mock answering `GET /pets/42` with an id of
**42**, and its whole configuration coming out as a file you can review in a pull request.

| | |
|---|---|
| Runtime | ~22 min, plus 10 min prep |
| You need | a terminal, a browser, this repo |
| Audience | engineers who have used a mock and been let down by one |
| Covers | SIM-2 (hosted mock), SIM-4 (scenarios/chaos), MSC-1.1 (correlation), MSC-1.2 (preview), MSC-1.4 (config as a file, offline preview) |

**How to read this.** Each act is a sequence of **DO** (what you click or type) and **SAY** (the
line you deliver). SAY lines are written to be spoken, not read aloud verbatim — rewrite them in
your own voice, but keep the beat each one lands.

Every command, URL and output below was run against a local `yarn dev` stack with the dev seed
(tenant `acme-corp`, user `ada@example.com`). Values shown as `<project>` are yours to fill in.

---

## Run sheet

| # | Act | The beat it lands | Time |
|---|-----|-------------------|------|
| 1 | Import the spec | There is no API yet — and now there is a project. | 2:00 |
| 2 | Publish and switch the mock on | One switch. No deploy, no generated server. | 2:30 |
| 3 | Curl it — and find the flaw | You asked for pet 42 and got someone else's pet. | 2:00 |
| 4 | Turn on correlation | Now it answers 42. With no request header. | 4:30 |
| 5 | Break it on purpose | Your error paths become testable. | 2:30 |
| 6 | Pull the whole thing as a file | Mock behaviour becomes reviewable code. | 5:00 |
| 7 | Unplug the network | Same answer, no control plane. | 3:00 |
| 8 | The CI drift gate | Close on the thing they'll actually adopt. | 1:30 |

---

## PREP — before anyone is watching (~10 min)

Do this the day before, and again ten minutes before. Two of these steps fail silently and take the
best moment of the demo with them.

**DO** — Start the stack from the repo root. This brings up the control panel on `:3000`, the REST
API on `:8000`, and the mock server on `:8775`.

```bash
yarn dev
```

**DO** — Turn on the preview endpoint. *This is the step that fails silently.* Without it, the
**Try it** panel in Act 4 and `apiome mock preview` in Act 7 both answer `503`. The Docker Compose
stack sets these for you; a `yarn dev` stack does not.

Append to `apiome-rest/.env`:

```
APIOME_MOCK_INTERNAL_BASE_URL=http://127.0.0.1:8775
APIOME_MOCK_INTERNAL_TOKEN=local-demo-preview-token
```

Append to `apiome-mock/.env` — the same value, byte for byte:

```
APIOME_MOCK_INTERNAL_TOKEN=local-demo-preview-token
```

REST reads `.env` once at import, so an edit does not reach a running server. Force a reload:

```bash
touch apiome-rest/src/app/main.py
```

**DO** — Set the CLI up in a second terminal. The dev seed ships this tenant and key; they are
development-only values that live in the repo.

```bash
export APIOME_BASE_URL=http://localhost:8000
export APIOME_TENANT_ID=acme-corp
export APIOME_API_KEY=sk_devseed00000000000000000000000000000000000000000000000000000000

cd apiome-cli && ./run.sh mock --help
```

You should see eight subcommands, including `config` and `preview`. If `./run.sh` is a mouthful on
screen, alias it: `alias apiome='<repo>/apiome-cli/run.sh'`.

**DO** — Have the spec on your desktop, not buried in the repo tree. It has a `/pets` collection and
a `/pets/{petId}` resource, which is exactly what Act 4 needs.

```bash
cp apiome-ui/examples/openapi/30-openapi-3.0-petstore.yaml ~/Desktop/petstore.yaml
```

**DO** — Log in at <http://localhost:3000/login> as `ada@example.com` / `apiome-dev`, tenant
**Acme Corp**. Leave the browser on the projects screen.

> If the seed password is rejected, the bcrypt hash in `apiome-db/seed/dev/001_user.sql` has drifted
> from the documented password — re-hash and update the row before the demo, not during it.

**DO** — Check that `--bundle` will have a runtime: either `apiome-mock` on `PATH` or Docker
available. If neither, prepend the mock's virtualenv when you get to Act 7.

**DO** — Do a full dry run, then delete the project you created.

> **Reset between runs.** Delete the imported project before demoing again. Re-importing the same
> spec into an existing project makes a second version, and the versions table stops being obvious
> on a projector.

---

## ACT 1 — Import the spec (2:00)

*Establish the starting position: a YAML file and nothing else. No server, no database, no team who
has written the API yet.*

**DO** — Browse to <http://localhost:3000/ade/dashboard/projects>.

**DO** — Click **Import**.

**DO** — Drop `petstore.yaml` onto the file panel. *Pause here* — the wizard identifies the format
itself.

**DO** — Accept the detected format and let the import run to completion.

**DO** — Note the project slug the import created; you need it for every CLI command from Act 6
onward. Set it now, quietly, in terminal 2:

```bash
export PROJ=<the-project-slug>
export VER=1.0.0
```

**SAY**

> I have not told it what this file is. I dropped it in and it worked out that this is OpenAPI 3.0 —
> the same way it would work out Protobuf, GraphQL, AsyncAPI, WSDL or a COBOL copybook. The list is
> a registry, not a switch statement.
>
> What I have now is a **project with a version** — an editable model of this API, not a copy of the
> file. Everything that follows hangs off that.

---

## ACT 2 — Publish, then switch the mock on (2:30)

*The whole setup cost of the mock is one switch. Land that, and land it fast — everything after this
is payoff.*

**DO** — Go to <http://localhost:3000/ade/dashboard/versions>.

**DO** — Publish version `1.0.0`. If the precheck objects that classes are missing descriptions,
tick **Force publish** and give a reason.

> Do not narrate the force-publish. It is a quality gate doing its job on a sample file, and
> explaining it costs you ninety seconds of momentum.

**DO** — On the version row, find the **Mock** column and flip the switch.

**DO** — A URL appears under the switch. Copy it with the button beside it, and read it aloud.

```
http://localhost:8775/acme-corp/<project>/1.0.0
```

**DO** — Set it in terminal 2 so the next act is one short command:

```bash
export MOCK=http://localhost:8775/acme-corp/$PROJ/$VER
```

**SAY**

> That is the entire setup. Nothing was generated, nothing was deployed, there is no scaffolded
> Express app sitting in a repo drifting away from the spec.
>
> **The mock is the version.** When someone publishes 1.1.0 tomorrow, the mock for 1.1.0 is correct
> on the same day — because it is not a copy of the contract, it *is* the contract.
>
> And that URL is shareable right now. Your mobile team can point at it this afternoon.

> **Worth knowing, not worth saying now:** a public mock needs a published version. A *draft* can
> also serve a private mock — same engine, but callers must present an API key. It is how a team
> develops against a version that is not ready to be seen.

---

## ACT 3 — Curl it, and find the flaw (2:00)

*This act deliberately shows the mock falling short. Do not skip it and do not apologise for it —
Act 4 has no punchline without it.*

**DO** — Hit the collection. It answers from the spec, with schema-shaped data.

```bash
curl -s $MOCK/pets | jq
```

**DO** — Now ask for one specific pet. **Point at the `id` in the response.**

```bash
curl -s $MOCK/pets/42 | jq
```

The shape of what comes back:

```jsonc
{
  "id": 7391,          // ← you asked for 42
  "name": "…",
  "tag": "…"
}
```

**SAY**

> Look at that. I asked for pet **42** and it handed me back a completely different pet. The status
> is right, the shape is right, every field validates against the schema — and the answer is wrong
> in the one way that matters.
>
> This is why mocks get abandoned. Your UI renders the detail page, the id in the URL and the id in
> the payload disagree, and now every developer on the team has an *if it's the mock, ignore the id*
> branch in their head.
>
> So: can we fix that without asking every consumer to send a special header? Because a generated
> SDK will not send one. A browser app will not send one.

---

## ACT 4 — Turn on correlation (4:30)

*The centrepiece. Slow down here. The visible before/after on a single curl is the thing people
remember.*

**DO** — Back on the versions row, click **Correlation**.

**DO** — Choose the **Inferred** mode card. *Do not save yet.*

> The cards describe what each mode does to a *response*, not what it is named.

**DO** — Read the bindings preview aloud. It lists, per operation, which response properties would
take which request values — before anything is stored.

```
GET /pets/{petId}
  id   ←  {{request.path.petId}}   path-params
```

**DO** — Open **Try it**, enter path `/pets/42`, and render. The id comes back as 42 — and still
nothing is saved.

**DO** — Point at the trace line: it names `correlation` as the layer that produced the body.

**DO** — Now **Save**.

**DO** — Return to the terminal and run the *exact same command as Act 3*. Include `-i` this time.

```bash
curl -si $MOCK/pets/42 | head -20
```

```http
HTTP/1.1 200 OK
content-type: application/json
x-mock-correlation: path-params
x-mock-schema-valid: true

{
  "id": 42,
  "name": "…"
}
```

**SAY**

> Same URL. Same command. **No new header on the request.** That is the entire point — this is
> configuration on the version, not an opt-in per call, so every consumer gets it, including the
> ones you do not control.
>
> The property is called `id` and the path parameter is called `petId`, and it matched them anyway.
> A parameter ending in *id* also answers to the bare `id`, because that is the spelling response
> schemas actually use.
>
> Two headers came back that you did not ask for. `x-mock-correlation` tells you which pass bound
> something. `x-mock-schema-valid` tells you the body it just built still validates against your own
> response schema — so if correlation ever writes a value your schema disallows, the mock *tells*
> you rather than quietly serving it.
>
> And when name-matching is not enough, the same editor lets you point a specific response pointer
> at a specific request value, by hand.

> **If Try it reports that preview is not configured**, the two environment variables from Prep did
> not reach the running REST process. Skip the preview beat, save the mode, and go straight to the
> curl — the payoff is the curl, not the panel.

---

## ACT 5 — Break it on purpose (2:30)

*Correlation makes the happy path believable. Scenarios make the unhappy paths reachable — the ones
nobody can test against a real staging environment.*

**DO** — On the version row, click **Scenarios**.

**DO** — Add a scenario named `outage`, and override `GET /pets` with status `503`. Save.

> Canned responses are validated against your spec on save — a status the operation does not declare
> is refused unless you deliberately mark it off-spec.

**DO** — Show that normal traffic is untouched, then select the scenario with one header.

```bash
curl -s -o /dev/null -w '%{http_code}\n' $MOCK/pets
curl -s -o /dev/null -w '%{http_code}\n' $MOCK/pets \
  -H 'X-Mock-Scenario: outage'
```

```
200
503
```

**SAY**

> Now your front-end team can build the error state. Not describe it in a ticket — build it, against
> a real HTTP response, this afternoon.
>
> The scenario is opt-in per request, so it sits alongside normal traffic instead of replacing it.
> One tester can be inside the outage while everyone else is not.
>
> There is a latency and error-injection layer here too — inject 300 milliseconds, or fail one
> request in twenty — which is how you find out whether your retry logic is real.

---

## ACT 6 — Pull the whole thing out as a file (5:00) — NEW

*Everything so far was clicked. For a team that reviews changes in pull requests, clicked
configuration is invisible configuration. This act closes that gap — and it is the one your senior
engineers will care about most.*

**DO** — Pull everything you just configured into one document.

```bash
apiome mock config pull $PROJ $VER --out mock-config.json
cat mock-config.json
```

```json
{
  "chaos": null,
  "configFormat": "apiome.mock.config/v1",
  "configFormatVersion": 1,
  "correlation": {
    "mode": "inferred",
    "operations": {}
  },
  "fixturePacks": {},
  "scenarios": {
    "outage": {
      "chaos": null,
      "description": "",
      "operations": {
        "GET /pets": { "responses": [ { "status": 503 } ] }
      }
    }
  }
}
```

**DO** — Prove it round-trips. Pull, commit, and the next diff is empty.

```bash
apiome mock config diff $PROJ $VER --file mock-config.json ; echo "exit $?"
```

```
No changes: mock-config.json against <project> 1.0.0.
exit 0
```

**DO** — Edit the file in front of them. Rename the scenario from `outage` to `maintenance`, then
diff again.

```
2 changes: mock-config.json against <project> 1.0.0.
  + scenarios["maintenance"]
  - scenarios["outage"]

--- <project> 1.0.0
+++ mock-config.json
@@ …
exit 1
```

**DO** — Break it on purpose — point the scenario at an operation that does not exist, say
`GET /nope` — and try to push it.

```bash
apiome mock config push $PROJ $VER --file mock-config.json --dry-run
```

```
mock-config.json was rejected (1 problem):
  scenarios["maintenance"].operations["GET /nope"]
      no operation GET /nope exists in this version's spec.
```

**DO** — Fix it and apply it.

```bash
apiome mock config push $PROJ $VER --file mock-config.json
```

```
Applied mock-config.json to <project> 1.0.0.
  + scenarios["maintenance"]
  - scenarios["outage"]
```

**DO** — Refresh the browser. The scenario list in the editor now says `maintenance`. Same store,
two doors.

**SAY**

> Everything I clicked in the last ten minutes is now a file. It diffs, it reviews, it belongs in
> the repo next to the spec it configures.
>
> Notice what the error did. It did not hand me a JSON blob from the server — it pointed at **the
> path in my file** that caused the problem. And it reports every problem in the document at once,
> not the first one, because it validates all of it before it writes any of it. A rejected file
> leaves the version exactly as it was.
>
> That validation is the server's, not the CLI's. There is no second copy of the rules here to drift
> out of step with the ones that actually apply.
>
> And the document carries no tenant, no project, no version. So this same file — reviewed,
> approved, merged — pushes to your staging version and then to production. Mock behaviour gets
> promoted, not re-clicked.

> **Say this plainly, because someone will ask:** a push *replaces* every section. A section the
> file leaves out is cleared, not left alone. That is why the document carries a `configFormat`
> marker — so no stray JSON file can be pushed into a version by accident. Use `--dry-run` first; it
> prints the change list and writes nothing.

---

## ACT 7 — Unplug the network (3:00) — NEW

*The claim is that hosted, portable and preview are one engine. This act is the proof, and it is a
physical, visible one: turn off the wifi in front of them.*

**DO** — Preview from the terminal first, against the hosted version. Same renderer as the **Try it**
panel.

```bash
apiome mock preview $PROJ $VER --path /pets/42
```

**DO** — Preview an edit you have not pushed — point `--file` at the local document. Nothing is
written; the render uses the file.

```bash
apiome mock preview $PROJ $VER --path /pets --file mock-config.json \
  --scenario maintenance
```

**DO** — Now go offline. Turn the wifi off, visibly. Then render a portable bundle with no control
plane at all — no API key, no tenant, no network.

```bash
apiome mock preview --path /pets/42 \
  --bundle apiome-mock/src/apiome_mock/conformance_data/bundle.json
```

Verbatim output:

```
GET /pets/42 → 200 application/json
  operation    GET /pets/{petId}
  layer        correlation
  detail       Correlation (path-params) rewrote the GET /pets/{petId}
               response with values from the request.
  body source  example
  correlation  inferred — path-params
  seed         15748080382582317156 (correlation)
  schema       valid

Headers
  content-type: application/json
  x-mock-correlation: path-params
  x-mock-schema-valid: true

Body
{
  "id": 42,
  "name": "Rex"
}
```

**SAY**

> No network. No credentials. No control plane. And the same answer, with the same trace, in the
> same shape.
>
> That is not a coincidence and it is not a second implementation kept in step by discipline. The
> hosted mock, the **Try it** panel, and this command all call the **same rendering function**.
> There is one engine, so there is nothing to drift.
>
> Which means a bundle can run in CI, on a plane, or inside an air-gapped network, and answer
> exactly what production's mock answers.

> **Using your own version's bundle instead** is a stronger story, and one extra command. Export it
> while the mock is on — `GET /v1/versions/acme-corp/<project-id>/<version-id>/mock/bundle`, ids
> from `apiome --json mock status $PROJ $VER` — then pass that file to `--bundle`. Prepare it before
> the demo. The shipped conformance bundle above is the zero-setup fallback when something has gone
> sideways.
>
> `--bundle` launches the portable runtime the way `apiome mock run` does, so it needs `apiome-mock`
> on `PATH` or Docker available. Check this in prep.

---

## ACT 8 — Close on the CI gate (1:30)

*End on the thing a team actually adopts on Monday: four lines in a pipeline.*

**DO** — Show the exit code doing the work. Someone edits the mock in the UI; the committed file no
longer matches; the build says so.

```yaml
# .github/workflows/mock.yml
- name: Mock configuration has not drifted
  run: apiome mock config diff $PROJECT $VERSION --file mock-config.json
  env:
    APIOME_API_KEY: ${{ secrets.APIOME_API_KEY }}
    APIOME_TENANT_ID: acme-corp
```

Exit codes:

```
0  the file and the version agree
1  they have drifted — the diff is in the log
2  the check could not run (bad file, auth, network)
```

**DO** — Stop there. Do not open a fourth topic.

**SAY**

> One and two are different answers, deliberately. A drift check that cannot tell *they differ* from
> *the server was down* is not a check — it is a flaky build everyone learns to ignore.
>
> So: twenty minutes ago this was a YAML file. Now it is a running API your consumers can build
> against, it answers with their own values, its failure modes are reachable, its whole behaviour is
> a reviewed file in your repo, and CI fails if anyone changes it behind your back.
>
> None of which required anyone to write a mock server.

---

## RESCUE — when it goes wrong on stage

Each of these has a recovery that costs under fifteen seconds. Know which act you can afford to
drop.

**The Try it panel says preview is not configured**
REST does not have `APIOME_MOCK_INTERNAL_BASE_URL` and `APIOME_MOCK_INTERNAL_TOKEN`, or the process
started before you added them.
*On stage:* skip the preview beat entirely. Save the correlation mode and go to the curl — Act 4's
payoff is the curl.

**The mock URL never appears after flipping the switch**
The version is not published. A public mock needs a published version; a draft only serves a
private, key-gated mock.
*On stage:* publish it, force-publishing if the precheck objects.

**`apiome mock config pull` returns 401 or 403**
The API key or tenant is not in the environment of *that* terminal. New tab, no exports.
*On stage:* re-run the three `export` lines from Prep. Keep them in your shell history as one line.

**`--bundle` reports that no runtime is available**
Neither `apiome-mock` nor `docker` is on `PATH` in that shell.
*On stage:* prepend the mock's virtualenv — `PATH="$PWD/apiome-mock/.venv/bin:$PATH"` — and re-run.

**The import hangs at "Creating project… Step 0 of 1"**
A previous abandoned import wizard left an idle Postgres transaction holding locks.
*On stage:* you cannot fix this live. This is why you do a dry run and terminate stale backends
beforehand.

**The seed login is rejected**
The bcrypt hash in the dev seed has drifted from the documented password.
*On stage:* nothing. Fix it in prep — this one ends the demo.

---

## IF ASKED — three questions that always come

**"Does the mock hold state? Can I POST and then GET it back?"**
Yes — session-scoped CRUD, keyed by a session header, so two testers never cross state. Fixture
packs seed a session with known data and pin a content digest, which is what lets a test assert
against it.

**"What happens when the spec changes?"**
The mock is the version, so publishing a new version gives you a correct mock for it the same day.
The configuration document is separate from the spec and pushes forward independently — which is
exactly why it carries no version identity.

**"Can I trust it enough to gate a release on it?"**
There is a shared conformance corpus that both the hosted runtime and the portable one must answer
identically, and a signed attestation recording which bundle was served, by which runtime, against
which corpus. That is the release-proof story — a separate demo, not this one.

---

## Reference

| Surface | Where |
|---|---|
| Control panel | <http://localhost:3000> |
| Projects (import) | <http://localhost:3000/ade/dashboard/projects> |
| Versions (mock switch, Scenarios, Correlation) | <http://localhost:3000/ade/dashboard/versions> |
| REST API | <http://localhost:8000> |
| Mock data plane | `http://localhost:8775/{tenant}/{project}/{version}` |
| Correlation guide | [guide/mock-response-correlation.md](guide/mock-response-correlation.md) |
| Preview guide | [guide/mock-response-preview.md](guide/mock-response-preview.md) |
| Portable runtime guide | [guide/portable-mock-runtime.md](guide/portable-mock-runtime.md) |
| Config document shape | [../apiome-mock/README.md](../apiome-mock/README.md) |
| CLI reference | [../apiome-cli/README.md](../apiome-cli/README.md) |
