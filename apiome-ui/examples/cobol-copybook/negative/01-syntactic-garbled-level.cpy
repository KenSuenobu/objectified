      *****************************************************************
      * COBOL copybook - invoice header for a billing feed. The level
      * number of the group item is fused to its name (no separator),
      * which is not a legal data-description entry.
      *****************************************************************
       01INVOICE-HEADER.
           05  INVOICE-NUMBER            PIC X(10).
           05  INVOICE-DATE              PIC 9(8).
           05  INVOICE-TOTAL             PIC S9(9)V99 COMP-3.
