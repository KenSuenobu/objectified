       01  CUSTOMER-REC.
           05  CUST-ID            PIC X(10).
           05  CUST-NAME          PIC X(40).
           05  CUST-BALANCE       PIC S9(11)V99 COMP-3.
           05  CUST-CONTACTS      OCCURS 5 TIMES.
               10  CONTACT-TYPE   PIC XX.
               10  CONTACT-VALUE  PIC X(60).
