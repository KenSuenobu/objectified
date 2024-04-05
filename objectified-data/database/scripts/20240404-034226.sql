DROP SCHEMA IF EXISTS obj CASCADE;
CREATE SCHEMA obj;

DROP TABLE IF EXISTS obj.user CASCADE;
DROP INDEX IF EXISTS idx_user_unique_username;

CREATE TABLE obj.user (
    id SERIAL NOT NULL PRIMARY KEY,
    username VARCHAR(80) NOT NULL,
    password VARCHAR(255) NOT NULL,
    email_address VARCHAR(255) NOT NULL,
    verified BOOLEAN NOT NULL DEFAULT false,
    data JSONB
);

CREATE UNIQUE INDEX idx_user_unique_username ON obj.user(UPPER(username));

CREATE TABLE obj.user_session (
    id SERIAL NOT NULL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES obj.user(id),
    token VARCHAR(500) NOT NULL,
    token_expire TIMESTAMP WITHOUT TIME ZONE NOT NULL
);


DROP TABLE IF EXISTS obj.namespace CASCADE;
DROP INDEX IF EXISTS idx_namespace_unique_name;

CREATE TABLE obj.namespace (
    id SERIAL NOT NULL PRIMARY KEY,
    creator_id INT NOT NULL REFERENCES obj.user(id),
    name VARCHAR(80) NOT NULL,
    description VARCHAR(4096) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    system_namespace BOOLEAN NOT NULL DEFAULT false,
    create_date TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_namespace_unique_name ON obj.namespace(UPPER(name));

-- Create core namespaces here, perhaps a pre-load script after starting up the application?
--
-- INSERT INTO obj.namespace (name, description, core_namespace, create_date)
-- VALUES ('system', 'Core system namespace used by Objectified', true, NOW());

