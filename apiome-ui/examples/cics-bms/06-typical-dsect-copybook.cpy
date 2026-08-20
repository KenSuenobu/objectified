      *****************************************************************
      * BMS-generated symbolic map for CUSTMAP: the COBOL copybook a  *
      * program actually references. The three fields per map field   *
      * (length, attribute, data) are the record layout the screen    *
      * becomes, and the -I/-O redefinition is the input/output pair. *
      *****************************************************************
       01  CUSTMAPI.
           02  FILLER PIC X(12).
           02  CUSTIDL    COMP  PIC  S9(4).
           02  CUSTIDF    PICTURE X.
           02  FILLER REDEFINES CUSTIDF.
               03 CUSTIDA    PICTURE X.
           02  CUSTIDI  PIC X(10).
           02  CUSTNAMEL    COMP  PIC  S9(4).
           02  CUSTNAMEF    PICTURE X.
           02  FILLER REDEFINES CUSTNAMEF.
               03 CUSTNAMEA    PICTURE X.
           02  CUSTNAMEI  PIC X(40).
           02  CUSTSTATL    COMP  PIC  S9(4).
           02  CUSTSTATF    PICTURE X.
           02  FILLER REDEFINES CUSTSTATF.
               03 CUSTSTATA    PICTURE X.
           02  CUSTSTATI  PIC X(1).
           02  CUSTBALL    COMP  PIC  S9(4).
           02  CUSTBALF    PICTURE X.
           02  FILLER REDEFINES CUSTBALF.
               03 CUSTBALA    PICTURE X.
           02  CUSTBALI  PIC X(15).
           02  MSGLINEL    COMP  PIC  S9(4).
           02  MSGLINEF    PICTURE X.
           02  FILLER REDEFINES MSGLINEF.
               03 MSGLINEA    PICTURE X.
           02  MSGLINEI  PIC X(60).
       01  CUSTMAPO REDEFINES CUSTMAPI.
           02  FILLER PIC X(12).
           02  FILLER PIC X(3).
           02  CUSTIDO  PIC X(10).
           02  FILLER PIC X(3).
           02  CUSTNAMEO  PIC X(40).
           02  FILLER PIC X(3).
           02  CUSTSTATO  PIC X(1).
           02  FILLER PIC X(3).
           02  CUSTBALO  PIC ZZZ,ZZZ,ZZ9.99-.
           02  FILLER PIC X(3).
           02  MSGLINEO  PIC X(60).
