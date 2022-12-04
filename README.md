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

### Phase 1

Design of REST services and DTOs (OpenAPI layer):

- [x] Namespaces
- [x] Classes
- [x] Data Types
- [x] Fields
- [x] Properties
- [ ] Object Properties
- [ ] Class Properties
- [ ] Instances
- [ ] Instance Data
