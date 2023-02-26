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

### Roadmap

The following is a list of items that will be done as the project grows.  This is
an approximation; this list may grow or shrink over time, depending on adoption
and popularity.

- [ ] UI
  - [ ] Base design and layout
  - [ ] Component library
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
  - [ ] Hosting on `http://objectified.blog`
