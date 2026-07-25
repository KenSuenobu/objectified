      *****************************************************************
      * COBOL copybook example - an everyday ACCOUNT-MASTER record with
      * a nested name group, level-88 account-type conditions, and a
      * packed-decimal balance.
      *****************************************************************
       01  ACCOUNT-MASTER.
           05  ACCT-NUMBER             PIC 9(12).
           05  ACCT-HOLDER.
               10  ACCT-HOLDER-NAME    PIC X(30).
               10  ACCT-HOLDER-TAX-ID  PIC X(11).
           05  ACCT-TYPE               PIC X(2).
               88  ACCT-CHECKING       VALUE 'CK'.
               88  ACCT-SAVINGS        VALUE 'SV'.
               88  ACCT-MONEY-MARKET   VALUE 'MM'.
           05  ACCT-BALANCE            PIC S9(11)V99 COMP-3.
           05  ACCT-OPEN-DATE          PIC 9(8).
           05  ACCT-LAST-ACTIVITY      PIC 9(8).
           05  ACCT-BRANCH-CODE        PIC 9(4).
