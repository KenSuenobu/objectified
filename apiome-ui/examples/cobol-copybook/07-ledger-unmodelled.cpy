      *****************************************************************
      * COBOL copybook composition example - a LEDGER record carrying
      * the clauses the parser deliberately does not model: a level-66
      * regrouping item, a nested member-inclusion statement with text
      * substitution, and a PIC N (national/DBCS) item that has no
      * computable byte length. Analysis must surface each as a
      * warning, never silently flatten or guess.
      *****************************************************************
       01  LEDGER-RECORD.
           05  LEDGER-ID               PIC 9(8).
           05  LEDGER-PERIOD.
               10  LEDGER-YEAR         PIC 9(4).
               10  LEDGER-MONTH        PIC 9(2).
           05  LEDGER-TITLE-NATIONAL   PIC N(20).
           05  LEDGER-AMOUNT           PIC S9(11)V99 COMP-3.
           05  LEDGER-STATUS           PIC X(1).
               88  LEDGER-OPEN         VALUE 'O'.
               88  LEDGER-CLOSED       VALUE 'C'.
       66  LEDGER-STAMP RENAMES LEDGER-YEAR THRU LEDGER-MONTH.
           COPY LEDGERTRL REPLACING ==:PRE:== BY ==LEDGER==.
