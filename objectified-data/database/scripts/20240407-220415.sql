---

DROP TABLE IF EXISTS obj.group CASCADE;
DROP INDEX IF EXISTS idx_group_unique_name;

CREATE TABLE obj.group (
    id SERIAL NOT NULL PRIMARY KEY,
    name VARCHAR(80) NOT NULL,
    description VARCHAR(4096) NOT NULL
);

CREATE UNIQUE INDEX idx_group_unique_name ON obj.group(UPPER(name));

---

DROP TABLE IF EXISTS obj.group_membership CASCADE;
DROP INDEX IF EXISTS idx_group_membership_unique;

CREATE TABLE obj.group_membership (
    id SERIAL NOT NULL PRIMARY KEY,
    group_id INT NOT NULL REFERENCES obj.group(id),
    user_id INT NOT NULL REFERENCES obj.user(id),
    is_admin BOOLEAN NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX idx_group_membership_unique ON obj.group_membership(group_id, user_id);

---

DROP TABLE IF EXISTS obj.group_namespace CASCADE;
DROP INDEX IF EXISTS idx_group_namespace_unique;

CREATE TABLE obj.group_namespace (
    id SERIAL NOT NULL PRIMARY KEY,
    group_id INT NOT NULL REFERENCES obj.group(id),
    namespace_id INT NOT NULL REFERENCES obj.namespace(id)
);

CREATE UNIQUE INDEX idx_group_namespace_unique ON obj.group_namespace(group_id, namespace_id);
