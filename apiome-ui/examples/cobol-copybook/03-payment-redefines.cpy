      *****************************************************************
      * COBOL copybook composition example - a PAYMENT record whose
      * detail area is laid out once and overlaid twice with REDEFINES:
      * the same storage is reused as either a card layout or a bank
      * layout, selected by the PAYMENT-TYPE code (level-88 conditions).
      *****************************************************************
       01  PAYMENT-RECORD.
           05  PAYMENT-ID              PIC 9(10).
           05  PAYMENT-TYPE            PIC X(1).
               88  PAY-BY-CARD         VALUE 'C'.
               88  PAY-BY-BANK         VALUE 'B'.
           05  PAYMENT-AMOUNT          PIC S9(9)V99 COMP-3.
           05  PAYMENT-DETAIL          PIC X(30).
           05  CARD-DETAIL REDEFINES PAYMENT-DETAIL.
               10  CARD-NUMBER         PIC 9(16).
               10  CARD-EXPIRY-YYMM    PIC 9(4).
               10  FILLER              PIC X(10).
           05  BANK-DETAIL REDEFINES PAYMENT-DETAIL.
               10  BANK-ROUTING        PIC 9(9).
               10  BANK-ACCOUNT        PIC X(17).
               10  FILLER              PIC X(4).
           05  PAYMENT-POSTED-DATE     PIC 9(8).
