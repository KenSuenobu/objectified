DROP SCHEMA IF EXISTS obj CASCADE;
CREATE SCHEMA obj;

---

DROP TABLE IF EXISTS obj.namespace CASCADE;
DROP INDEX IF EXISTS idx_namespace_unique_name;

CREATE TABLE obj.namespace (
    id SERIAL NOT NULL PRIMARY KEY,
    name VARCHAR(80) NOT NULL,
    description VARCHAR(4096) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    create_date TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_namespace_unique_name ON obj.namespace(name);

---

DROP TABLE IF EXISTS obj.class CASCADE;
DROP INDEX IF EXISTS idx_class_unique_name;

CREATE TABLE obj.class (
    id SERIAL NOT NULL PRIMARY KEY,
    name VARCHAR(80) NOT NULL,
    description VARCHAR(4096) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    create_date TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
    update_date TIMESTAMP WITHOUT TIME ZONE,
    delete_date TIMESTAMP WITHOUT TIME ZONE
);

CREATE UNIQUE INDEX idx_class_unique_name ON obj.class(name);

---

DROP TYPE IF EXISTS obj.data_type_enum CASCADE;
CREATE TYPE obj.data_type_enum AS ENUM (
    'STRING', 'INT32', 'INT64', 'FLOAT', 'DOUBLE', 'BOOLEAN', 'DATE', 'DATE_TIME',
    'BYTE', 'BINARY', 'PASSWORD', 'OBJECT'
);

DROP TABLE IF EXISTS obj.data_type CASCADE;
DROP INDEX IF EXISTS idx_data_type_unique_name;

CREATE TABLE obj.data_type (
    id SERIAL NOT NULL PRIMARY KEY,
    name VARCHAR(80) NOT NULL,
    description VARCHAR(4096) NOT NULL,
    data_type obj.data_type_enum NOT NULL,
    is_array BOOLEAN NOT NULL DEFAULT false,
    max_length INT NOT NULL DEFAULT 0,
    pattern TEXT,
    enum_values TEXT[],
    enum_descriptions TEXT[],
    examples TEXT[],
    enabled BOOLEAN NOT NULL DEFAULT true,
    create_date TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
    update_date TIMESTAMP WITHOUT TIME ZONE,
    delete_date TIMESTAMP WITHOUT TIME ZONE
);

CREATE UNIQUE INDEX idx_data_type_unique_name ON obj.data_type(name);

---

DROP TABLE IF EXISTS obj.field CASCADE;
DROP INDEX IF EXISTS idx_field_unique_name;

CREATE TABLE obj.field (
    id SERIAL NOT NULL PRIMARY KEY,
    data_type_id INT NOT NULL REFERENCES obj.data_type(id),
    name VARCHAR(80) NOT NULL,
    description VARCHAR(4096) NOT NULL,
    default_value TEXT,
    enabled BOOLEAN NOT NULL DEFAULT true,
    create_date TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
    update_date TIMESTAMP WITHOUT TIME ZONE,
    delete_date TIMESTAMP WITHOUT TIME ZONE
);

CREATE UNIQUE INDEX idx_field_unique_name ON obj.field(name);

---

DROP TABLE IF EXISTS obj.property CASCADE;
DROP INDEX IF EXISTS idx_property_unique_name;

CREATE TABLE obj.property (
    id SERIAL NOT NULL PRIMARY KEY,
    name VARCHAR(80) NOT NULL,
    description VARCHAR(4096) NOT NULL,
    field_id INT NOT NULL REFERENCES obj.field(id),
    required BOOLEAN NOT NULL DEFAULT false,
    nullable BOOLEAN NOT NULL DEFAULT false,
    is_array BOOLEAN NOT NULL DEFAULT false,
    default_value TEXT,
    enabled BOOLEAN NOT NULL DEFAULT true,
    indexed BOOLEAN NOT NULL DEFAULT false,
    create_date TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
    update_date TIMESTAMP WITHOUT TIME ZONE,
    delete_date TIMESTAMP WITHOUT TIME ZONE
);

CREATE UNIQUE INDEX idx_property_unique_name ON obj.property(name);

---

DROP TABLE IF EXISTS obj.object_property CASCADE;
DROP INDEX IF EXISTS idx_object_property_unique;

CREATE TABLE obj.object_property (
    id SERIAL NOT NULL PRIMARY KEY,
    parent_id INT NOT NULL REFERENCES obj.property(id),
    child_id INT NOT NULL REFERENCES obj.property(id)
);

CREATE UNIQUE INDEX idx_object_property_unique ON obj.object_property(parent_id, child_id);

---

DROP TABLE IF EXISTS obj.class_property CASCADE;
DROP INDEX IF EXISTS idx_class_property_unique;

CREATE TABLE obj.class_property (
    id SERIAL NOT NULL PRIMARY KEY,
    class_id INT NOT NULL REFERENCES obj.class(id),
    property_id INT NOT NULL REFERENCES obj.property(id)
);

CREATE UNIQUE INDEX idx_class_property_unique ON obj.class_property(class_id, property_id);

---

DROP TABLE IF EXISTS obj.instance CASCADE;
DROP INDEX IF EXISTS idx_obj_instance_name_classes;

CREATE TABLE obj.instance (
    id SERIAL NOT NULL PRIMARY KEY,
    name VARCHAR(80) NOT NULL,
    description VARCHAR(4096) NOT NULL,
    class_id INT NOT NULL REFERENCES obj.class(id),
    enabled BOOLEAN NOT NULL DEFAULT true,
    create_date TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
    update_date TIMESTAMP WITHOUT TIME ZONE,
    delete_date TIMESTAMP WITHOUT TIME ZONE
);

CREATE INDEX idx_obj_instance_name_classes ON obj.instance(name, class_id, create_date);

---

DROP TABLE IF EXISTS obj.instance_data CASCADE;
DROP INDEX IF EXISTS obj_instance_data_id_version;

CREATE TABLE obj.instance_data (
    id SERIAL NOT NULL PRIMARY KEY,
    instance_id INT NOT NULL REFERENCES obj.instance(id),
    instance_data JSONB NOT NULL,
    instance_version BIGINT,
    date TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);

CREATE UNIQUE INDEX obj_instance_data_id_version ON obj.instance_data(instance_id, instance_version);

---

DROP TABLE IF EXISTS obj.instance_data_index;
DROP INDEX IF EXISTS idx_obj_instance_data_index;

CREATE TABLE obj.instance_data_index (
    id SERIAL NOT NULL PRIMARY KEY,
    instance_data_id INT NOT NULL REFERENCES obj.instance_data(id),
    property_id INT NOT NULL REFERENCES obj.property(id),
    value TEXT
);

CREATE INDEX idx_obj_instance_data_index ON obj.instance_data_index(instance_data_id, property_id, value);
