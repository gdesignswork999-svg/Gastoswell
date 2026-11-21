CREATE DATABASE IF NOT EXISTS gastoswell
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE gastoswell;

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(64) NOT NULL,
  username VARCHAR(64) NOT NULL,
  key_salt VARCHAR(64) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS accounts (
  id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  name VARCHAR(120) NOT NULL,
  account_type VARCHAR(80) NOT NULL,
  balance DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_accounts_user_id (user_id, id),
  KEY idx_accounts_user (user_id),
  CONSTRAINT fk_accounts_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bills (
  id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  name VARCHAR(120) NOT NULL,
  amount DECIMAL(15,2) NOT NULL,
  due_day TINYINT UNSIGNED NOT NULL,
  category VARCHAR(100) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_bills_user_id (user_id, id),
  KEY idx_bills_user (user_id),
  CONSTRAINT fk_bills_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS transactions (
  id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  type ENUM('income', 'expense') NOT NULL,
  amount DECIMAL(15,2) NOT NULL,
  category VARCHAR(100) NOT NULL,
  transaction_date DATE NOT NULL,
  transaction_time TIME NULL,
  note VARCHAR(500) NOT NULL DEFAULT '',
  account_id VARCHAR(64) NULL,
  account_name VARCHAR(120) NULL,
  bill_id VARCHAR(64) NULL,
  bill_month CHAR(7) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_transactions_user_date (user_id, transaction_date),
  KEY idx_transactions_user_category_date (user_id, category, transaction_date),
  UNIQUE KEY uq_transactions_bill_period (bill_id, bill_month),
  CONSTRAINT fk_transactions_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE,
  CONSTRAINT fk_transactions_account
    FOREIGN KEY (user_id, account_id) REFERENCES accounts (user_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_transactions_bill
    FOREIGN KEY (user_id, bill_id) REFERENCES bills (user_id, id)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS debts (
  id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  name VARCHAR(120) NOT NULL,
  total DECIMAL(15,2) NOT NULL,
  remaining DECIMAL(15,2) NOT NULL,
  interest_percent DECIMAL(7,3) NOT NULL DEFAULT 0.000,
  minimum_payment DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_debts_user_id (user_id, id),
  KEY idx_debts_user (user_id),
  CONSTRAINT fk_debts_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS savings_goals (
  id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  name VARCHAR(120) NOT NULL,
  target DECIMAL(15,2) NOT NULL,
  current_amount DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  monthly_target DECIMAL(15,2) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_savings_goals_user_id (user_id, id),
  KEY idx_savings_goals_user (user_id),
  CONSTRAINT fk_savings_goals_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS encrypted_workspaces (
  user_id VARCHAR(64) NOT NULL,
  payload JSON NOT NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_encrypted_workspaces_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
