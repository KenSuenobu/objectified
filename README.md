# objectified-db

## What is Objectified?

Objectified is a time-series object database that supports dynamic schemas.

It uses REST services to programmatically provide CRUD services for 
data operations.

Schemas are programmatically defined, allowing for custom definitions of
objects, data fields, and data storage properties.

All of this is controlled and configured using a simple UI.

### How to build

You need the latest versions of node and yarn.

To build, simply type:

```shell
yarn install
yarn build
```

From the top level of the project.

### Installing the Database

You will need to download the [schema evolution manager](https://github.com/mbryzek/schema-evolution-manager)
tools.

Once downloaded and installed, install the database schema in the `objectified-data`
project by using `yarn bootstrap` to bootstrap the database.  You must have
Postgres installed.

### Starting the services

You will need to start two modules: the `objectified-services` module, and
the `objectified-ui` module.  To start the `objectified-services`, use
the following commands:

```shell
cd objectified-services
yarn start
```

This will start the server on port 3001.  [Click here to explore the
services documentation](objectified-services/README.md).

Then, you will want to start the UI, `objectified-ui`.  To do so, use the
following commands in a new terminal window:

```shell
cd objectified-ui
yarn start
```

This will start the UI.

Tune a browser to http://localhost:3000/.  Follow the instructions if you
are a new user, or use the dashboard elements to build and maintain your
schema.

[Click here to explore the UI documentation](objectified-ui/README.md).

## Development Plans

### Phase 4

- [x] Remove requirement of `pg` and `pg-promise` in services, only require in `objectified-data`.
- [ ] Create Instance Grouping
  - [ ] Group is a series of instances that all relate to one another
  - [ ] Group contains a parent ID and child IDs are the instances related to the group
  - [ ] Grouping is used for things like Chain-of-Custody or a document group
- [ ] REST service implementations
  - [x] Namespaces
  - [ ] Classes
  - [ ] Data Types
  - [ ] Fields
  - [ ] Properties
  - [ ] Object Properties
  - [ ] Class Properties
  - [ ] Instances
  - [ ] Instance Data
  - [ ] Instance Data Index

### Phase 3

Database System:

- [x] Initial design
  - [x] Namespaces
    - [x] Unit tests
  - [x] Classes
    - [x] Unit tests
  - [x] Data Types
    - [x] Unit tests
    - [x] Design initial importable data types
    - [x] Addition of base/core data types
  - [x] Fields
    - [x] Unit tests
  - [x] Properties
    - [x] Unit tests
  - [x] Object Properties
    - [x] Unit tests
  - [x] Class Properties
    - [x] Unit tests
  - [x] Instances
    - [x] Unit tests
  - [x] Instance Data
    - [x] Unit tests
  - [x] Instance Data Field Indexing

### Phase 2

Design Database.  Use `sem-tools` to define the schema and loading the database.

- [x] Postgres Schema
  - [x] Namespaces
  - [x] Classes
  - [x] Data Types
  - [x] Fields
  - [x] Properties
  - [x] Object Properties
  - [x] Class Properties
  - [x] Instances
  - [x] Instance Data
  - [x] Instance Data Index

### Phase 1

Design of REST services and DTOs (OpenAPI layer):

- [x] Namespaces
- [x] Classes
- [x] Data Types
- [x] Fields
- [x] Properties
- [x] Object Properties
- [x] Class Properties
- [x] Instances
- [x] Instance Data
- [x] Design initial documentation for objectified.dev docs site
  - [x] Skeleton is fine
- [x] Design Knowledge Base site for objectified.dev docs site
  - [x] Skeleton is fine
- [x] Generate Issues section in GitHub
  - [x] Define issue types
  - [x] Assign all phase objects with issues and document them here
