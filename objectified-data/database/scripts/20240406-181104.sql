---

DROP TABLE IF EXISTS obj.instance CASCADE;
DROP INDEX IF EXISTS idx_obj_instance_name_classes;

CREATE TABLE obj.instance (
    id SERIAL NOT NULL PRIMARY KEY,
    namespace_id INT NOT NULL REFERENCES obj.namespace(id),
    class_id INT NOT NULL REFERENCES obj.class(id),
    owner_id INT NOT NULL REFERENCES obj.user(id),
    name VARCHAR(80) NOT NULL,
    description VARCHAR(4096) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    create_date TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
    update_date TIMESTAMP WITHOUT TIME ZONE,
    delete_date TIMESTAMP WITHOUT TIME ZONE
);

CREATE INDEX idx_obj_instance_name_classes ON obj.instance(namespace_id, UPPER(name), class_id, create_date);

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
