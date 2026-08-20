       01  CUSTOMER-RECORD.
           05  CUSTOMER-NUMBER    PIC X(10).
           05  CUSTOMER-NAME      PIC X(40).
           05  CUSTOMER-STATUS    PIC X.
           05  BALANCE            PIC S9(9)V99 COMP-3.
           05  PHONE-NUMBERS      OCCURS 5 TIMES.
               10  PHONE-NUMBER   PIC X(20).
