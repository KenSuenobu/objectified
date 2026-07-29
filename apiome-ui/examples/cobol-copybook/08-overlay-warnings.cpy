      *****************************************************************
      * COBOL copybook composition example - an ACCOUNT snapshot whose
      * REDEFINES overlays are deliberately imperfect: SNAP-WIDE needs
      * more storage than the item it redefines, and SNAP-ORPHAN
      * redefines an item this copybook never declares (it lives in a
      * surrounding copybook). Analysis records both facts as evidence
      * about the copybook rather than adjusting either layout to fit.
      *****************************************************************
       01  ACCOUNT-SNAPSHOT.
           05  SNAP-ID                 PIC 9(6).
           05  SNAP-BODY               PIC X(10).
           05  SNAP-WIDE REDEFINES SNAP-BODY.
               10  SNAP-WIDE-CODE      PIC X(8).
               10  SNAP-WIDE-EXTRA     PIC X(6).
           05  SNAP-ORPHAN REDEFINES SNAP-MISSING.
               10  SNAP-ORPHAN-KEY     PIC X(4).
           05  SNAP-POSTED-DATE        PIC 9(8).
