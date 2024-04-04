# objectified-db 

## What is Objectified?

Objectified is a time-series object database that supports dynamic schemas.

It uses REST services to programmatically provide CRUD services for 
data operations.

Schemas are programmatically defined, allowing for custom definitions of
objects, data fields, and data type properties.

All of this is controlled and configured using a simple UI.

### Prerequisites

- [PostgreSQL 16+](https://www.postgresql.org/)
- [Schema Evolution Manager](https://github.com/mbryzek/schema-evolution-manager) tools

[//]: # (### How to build)

[//]: # ()
[//]: # (You need the latest versions of node and yarn.)

[//]: # ()
[//]: # (To install and use the latest version, using `nvm` to update your latest packages)

[//]: # (is recommended.  See [this link]&#40;https://github.com/nvm-sh/nvm&#41; for more information.)

[//]: # ()
[//]: # (After installing the latest versions of `npm` and `yarn`, follow these directions below.)

[//]: # ()
[//]: # (To build, simply type:)

[//]: # ()
[//]: # (```shell)

[//]: # (yarn install)

[//]: # (yarn build)

[//]: # (```)

[//]: # ()
[//]: # (From the top level of the project.)

[//]: # ()
[//]: # (### Installing the Database)

[//]: # ()
[//]: # (You will need to download the [schema evolution manager]&#40;https://github.com/mbryzek/schema-evolution-manager&#41;)

[//]: # (tools.)

[//]: # ()
[//]: # (Once downloaded and installed, install the database schema in the `objectified-data`)

[//]: # (project by using `yarn bootstrap` to bootstrap the database.  You must have)

[//]: # (Postgres installed.)

[//]: # ()
[//]: # (### Starting the services)

[//]: # ()
[//]: # (You will need to start two modules: the `objectified-services` module, and)

[//]: # (the `objectified-ui` module.  To start the `objectified-services`, use)

[//]: # (the following commands:)

[//]: # ()
[//]: # (```shell)

[//]: # (cd objectified-services)

[//]: # (yarn start)

[//]: # (```)

[//]: # ()
[//]: # (This will start the server on port 3001.  [Click here to explore the)

[//]: # (services documentation]&#40;objectified-services-old/README.md&#41;.)

[//]: # ()
[//]: # (Then, you will want to start the UI, `objectified-ui`.  To do so, use the)

[//]: # (following commands in a new terminal window:)

[//]: # ()
[//]: # (```shell)

[//]: # (cd objectified-ui)

[//]: # (yarn start)

[//]: # (```)

[//]: # ()
[//]: # (This will start the UI.)

[//]: # ()
[//]: # (Tune a browser to http://localhost:3000/.  Follow the instructions if you)

[//]: # (are a new user, or use the dashboard elements to build and maintain your)

[//]: # (schema.)

[//]: # ()
[//]: # ([Click here to explore the UI documentation]&#40;objectified-ui-old/README.md&#41;.)

## Development Plans

### Issues

Please refer to [this link](https://github.com/KenSuenobu/objectified/issues) to review
outstanding issues with Objectified.

### Roadmap

The following is a list of items that will be done as the project grows.  This is
an approximation; this list may grow or shrink over time, depending on adoption
and popularity.

- [ ] CI/CD
  - [ ] Build working in CircleCI

- [ ] UI
  - [ ] Base design and layout
  - [ ] Component library
    - [ ] Namespaces
    - [ ] Classes
    - [ ] Data Types
    - [ ] Fields
    - [ ] Properties
    - [ ] Object Properties
    - [ ] Class Properties
    - [ ] Instances
    - [ ] Instance Groups
  - [ ] Core functionality using REST

- [ ] ETL
  - [ ] Extract, Transform, and Load library
    - [ ] Typescript
    - [ ] Python
    - [ ] Go
    - [ ] Rust

- [ ] Blog Site
  - [ ] Schema design
  - [ ] Simple UI design
  - [ ] User accounts
  - [ ] Sections
  - [ ] Postings
  - [ ] Hosting on `http://objectified.wiki`
