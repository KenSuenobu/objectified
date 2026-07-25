      *****************************************************************
      * COBOL copybook stress example - the grammar's less common
      * corners in one record: a variable-length table (OCCURS ...
      * DEPENDING ON), mixed usages (COMP, COMP-3, BINARY), FILLER
      * items, deep nesting (levels 01/05/10/15), signed pictures with
      * implied decimals, and level-88 conditions with multiple values.
      *****************************************************************
       01  WAREHOUSE-SNAPSHOT.
           05  WH-ID                   PIC X(4).
           05  WH-REGION-CODE          PIC 9(2) COMP.
           05  WH-CAPACITY-UNITS       PIC 9(8) BINARY.
           05  WH-UTILIZATION-PCT      PIC S9(3)V9(2) COMP-3.
           05  FILLER                  PIC X(5).
           05  WH-BIN-COUNT            PIC 9(3).
           05  WH-BINS OCCURS 1 TO 10 TIMES DEPENDING ON WH-BIN-COUNT.
               10  BIN-ID              PIC X(6).
               10  BIN-STATUS          PIC X(1).
                   88  BIN-ACTIVE      VALUE 'A'.
                   88  BIN-UNUSABLE    VALUE 'B' 'X'.
               10  BIN-MEASURES.
                   15  BIN-WEIGHT-KG   PIC S9(5)V9(3) COMP-3.
                   15  BIN-VOLUME-M3   PIC S9(3)V9(3) COMP-3.
               10  BIN-LAST-COUNTED    PIC 9(8).
           05  WH-AUDIT.
               10  WH-AUDIT-USER       PIC X(8).
               10  WH-AUDIT-TS         PIC 9(14).
