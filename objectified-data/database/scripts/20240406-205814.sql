---

DROP TABLE IF EXISTS obj.link_def CASCADE;
DROP INDEX IF EXISTS idx_link_def_unique_name;

CREATE TABLE obj.link_def (
    id SERIAL NOT NULL PRIMARY KEY,
    namespace_id INT NOT NULL REFERENCES obj.namespace(id),
    t1 INT NOT NULL REFERENCES obj.class(id),
    t2 INT NOT NULL REFERENCES obj.class(id),
    name VARCHAR(80) NOT NULL,
    description VARCHAR(4096) NOT NULL
);

CREATE UNIQUE INDEX idx_link_def_unique_name ON obj.link_def(namespace_id, UPPER(name));

---

DROP TABLE IF EXISTS obj.link CASCADE;
DROP INDEX IF EXISTS idx_link_unique_name;

CREATE TABLE obj.link (
    int SERIAL NOT NULL PRIMARY KEY,
    name VARCHAR(80) NOT NULL,
    link_def_id INT NOT NULL REFERENCES obj.link_def(id),
    t1 INT NOT NULL REFERENCES obj.instance(id),
    t2 INT NOT NULL REFERENCES obj.instance(id),
    t3 JSON,
    create_date TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_link_unique_name ON obj.link(link_def_id, UPPER(name));
