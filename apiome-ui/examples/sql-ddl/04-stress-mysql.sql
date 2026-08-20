-- MySQL dialect: the vendor constructs an ANSI-only parser trips over.

CREATE DATABASE IF NOT EXISTS shop
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_0900_ai_ci;

USE shop;

CREATE TABLE `product` (
  `product_id`   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `sku`          VARCHAR(18) NOT NULL,
  `name`         VARCHAR(120) NOT NULL,
  `kind`         ENUM('physical','digital','service') NOT NULL DEFAULT 'physical',
  `channels`     SET('web','store','partner') DEFAULT NULL,
  `price_minor`  INT NOT NULL DEFAULT 0,
  `currency`     CHAR(3) NOT NULL DEFAULT 'EUR',
  `price_major`  DECIMAL(13,2) AS (`price_minor` / 100) STORED,
  `attributes`   JSON DEFAULT NULL,
  `search_blob`  TEXT,
  `weight_g`     MEDIUMINT UNSIGNED DEFAULT NULL,
  `discontinued` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`product_id`),
  UNIQUE KEY `product_sku_uq` (`sku`),
  KEY `product_kind_idx` (`kind`, `discontinued`),
  FULLTEXT KEY `product_search_ft` (`name`, `search_blob`),
  CONSTRAINT `product_price_non_negative` CHECK (`price_minor` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Sellable products';

CREATE TABLE `stock` (
  `product_id` BIGINT UNSIGNED NOT NULL,
  `warehouse`  CHAR(3) NOT NULL,
  `on_hand`    INT NOT NULL DEFAULT 0,
  `reserved`   INT NOT NULL DEFAULT 0,
  `available`  INT AS (`on_hand` - `reserved`) VIRTUAL,
  PRIMARY KEY (`product_id`, `warehouse`),
  CONSTRAINT `stock_product_fk`
    FOREIGN KEY (`product_id`) REFERENCES `product` (`product_id`)
    ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE `price_history` (
  `product_id`  BIGINT UNSIGNED NOT NULL,
  `valid_from`  DATE NOT NULL,
  `price_minor` INT NOT NULL,
  PRIMARY KEY (`product_id`, `valid_from`)
) ENGINE=InnoDB
PARTITION BY RANGE (YEAR(`valid_from`)) (
  PARTITION p2024 VALUES LESS THAN (2025),
  PARTITION p2025 VALUES LESS THAN (2026),
  PARTITION pmax  VALUES LESS THAN MAXVALUE
);

ALTER TABLE `product`
  ADD COLUMN `brand` VARCHAR(60) NULL AFTER `name`,
  ADD KEY `product_brand_idx` (`brand`);

ALTER TABLE `stock`
  ADD CONSTRAINT `stock_non_negative` CHECK (`on_hand` >= 0 AND `reserved` >= 0);
