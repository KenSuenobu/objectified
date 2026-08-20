/*
    SQL Server dialect: a claims schema in the shape an insurance estate ships —
    schemas, IDENTITY keys, NVARCHAR text, computed columns, filtered indexes,
    a temporal table and a view.
*/

CREATE SCHEMA claims;
GO

CREATE TABLE claims.Policy
(
    PolicyId        INT IDENTITY(1,1)   NOT NULL,
    PolicyNumber    NVARCHAR(20)        NOT NULL,
    HolderName      NVARCHAR(120)       NOT NULL,
    ProductCode     CHAR(6)             NOT NULL,
    EffectiveFrom   DATE                NOT NULL,
    EffectiveTo     DATE                NULL,
    AnnualPremium   DECIMAL(13, 2)      NOT NULL CONSTRAINT DF_Policy_Premium DEFAULT (0),
    IsActive        AS (CASE WHEN EffectiveTo IS NULL OR EffectiveTo >= CAST(GETDATE() AS DATE)
                             THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END) PERSISTED,
    RowVersion      ROWVERSION          NOT NULL,
    CONSTRAINT PK_Policy PRIMARY KEY CLUSTERED (PolicyId),
    CONSTRAINT UQ_Policy_Number UNIQUE (PolicyNumber),
    CONSTRAINT CK_Policy_Period CHECK (EffectiveTo IS NULL OR EffectiveTo > EffectiveFrom)
);
GO

CREATE TABLE claims.Claim
(
    ClaimId         BIGINT IDENTITY(1,1) NOT NULL,
    PolicyId        INT                  NOT NULL,
    ClaimReference  NVARCHAR(24)         NOT NULL,
    IncidentDate    DATE                 NOT NULL,
    ReportedAt      DATETIME2(3)         NOT NULL CONSTRAINT DF_Claim_Reported DEFAULT SYSUTCDATETIME(),
    Status          NVARCHAR(16)         NOT NULL CONSTRAINT DF_Claim_Status DEFAULT N'open',
    ReserveAmount   DECIMAL(15, 2)       NOT NULL CONSTRAINT DF_Claim_Reserve DEFAULT (0),
    PaidAmount      DECIMAL(15, 2)       NOT NULL CONSTRAINT DF_Claim_Paid DEFAULT (0),
    Description     NVARCHAR(MAX)        NULL,
    Attachment      VARBINARY(MAX)       NULL,
    CONSTRAINT PK_Claim PRIMARY KEY CLUSTERED (ClaimId),
    CONSTRAINT UQ_Claim_Reference UNIQUE (ClaimReference),
    CONSTRAINT FK_Claim_Policy FOREIGN KEY (PolicyId)
        REFERENCES claims.Policy (PolicyId) ON DELETE NO ACTION,
    CONSTRAINT CK_Claim_Status CHECK (Status IN (N'open', N'assessing', N'settled', N'rejected'))
);
GO

CREATE TABLE claims.ClaimPayment
(
    PaymentId   BIGINT IDENTITY(1,1) NOT NULL,
    ClaimId     BIGINT               NOT NULL,
    PaidOn      DATE                 NOT NULL,
    Amount      DECIMAL(15, 2)       NOT NULL,
    Method      NVARCHAR(20)         NOT NULL,
    CONSTRAINT PK_ClaimPayment PRIMARY KEY CLUSTERED (PaymentId),
    CONSTRAINT FK_ClaimPayment_Claim FOREIGN KEY (ClaimId)
        REFERENCES claims.Claim (ClaimId) ON DELETE CASCADE,
    CONSTRAINT CK_ClaimPayment_Amount CHECK (Amount > 0)
);
GO

CREATE NONCLUSTERED INDEX IX_Claim_Policy ON claims.Claim (PolicyId) INCLUDE (Status, ReserveAmount);
GO

CREATE NONCLUSTERED INDEX IX_Claim_Open ON claims.Claim (ReportedAt DESC)
    WHERE Status IN (N'open', N'assessing');
GO

CREATE VIEW claims.vOutstandingClaims
AS
SELECT  c.ClaimId,
        c.ClaimReference,
        p.PolicyNumber,
        c.ReserveAmount - c.PaidAmount AS Outstanding
FROM    claims.Claim AS c
JOIN    claims.Policy AS p ON p.PolicyId = c.PolicyId
WHERE   c.Status IN (N'open', N'assessing');
GO

ALTER TABLE claims.Claim
    ADD LossAdjusterId INT NULL;
GO
