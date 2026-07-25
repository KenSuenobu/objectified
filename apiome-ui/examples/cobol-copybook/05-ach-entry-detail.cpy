      *****************************************************************
      * COBOL copybook real-world example - a hand-authored
      * reconstruction of the shape of the NACHA ACH Entry Detail
      * record (record type 6) from the public ACH file format. No
      * third-party text copied; field names and widths follow the
      * publicly documented layout only.
      *****************************************************************
       01  ACH-ENTRY-DETAIL.
           05  ACH-RECORD-TYPE         PIC X(1).
               88  ACH-IS-ENTRY-DETAIL VALUE '6'.
           05  ACH-TRANSACTION-CODE    PIC 9(2).
               88  ACH-CHECKING-CREDIT VALUE 22.
               88  ACH-CHECKING-DEBIT  VALUE 27.
               88  ACH-SAVINGS-CREDIT  VALUE 32.
               88  ACH-SAVINGS-DEBIT   VALUE 37.
           05  ACH-RECEIVING-DFI-ID    PIC 9(8).
           05  ACH-CHECK-DIGIT         PIC 9(1).
           05  ACH-DFI-ACCOUNT-NUMBER  PIC X(17).
           05  ACH-AMOUNT              PIC 9(8)V99.
           05  ACH-INDIVIDUAL-ID       PIC X(15).
           05  ACH-INDIVIDUAL-NAME     PIC X(22).
           05  ACH-DISCRETIONARY-DATA  PIC X(2).
           05  ACH-ADDENDA-INDICATOR   PIC 9(1).
           05  ACH-TRACE-NUMBER        PIC 9(15).
