 /* Included member: the money block used for totals and line prices. */
 DCL 1 MONEY_BLOCK,
       2 MONEY_AMOUNT   FIXED DEC(15,2),
       2 MONEY_CURRENCY CHAR(3),
       2 MONEY_SIGN     CHAR(1);
