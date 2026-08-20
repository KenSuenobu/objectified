      *****************************************************************
      * Fileset member: the symbolic map generated from ORDRSET.bms.  *
      *****************************************************************
       01  ORDRMAPI.
           02  FILLER PIC X(12).
           02  ORDIDL    COMP  PIC  S9(4).
           02  ORDIDF    PICTURE X.
           02  FILLER REDEFINES ORDIDF.
               03 ORDIDA    PICTURE X.
           02  ORDIDI  PIC X(10).
           02  ORDSTATL    COMP  PIC  S9(4).
           02  ORDSTATF    PICTURE X.
           02  FILLER REDEFINES ORDSTATF.
               03 ORDSTATA    PICTURE X.
           02  ORDSTATI  PIC X(1).
           02  ORDTOTL    COMP  PIC  S9(4).
           02  ORDTOTF    PICTURE X.
           02  FILLER REDEFINES ORDTOTF.
               03 ORDTOTA    PICTURE X.
           02  ORDTOTI  PIC X(13).
           02  ORDMSGL    COMP  PIC  S9(4).
           02  ORDMSGF    PICTURE X.
           02  FILLER REDEFINES ORDMSGF.
               03 ORDMSGA    PICTURE X.
           02  ORDMSGI  PIC X(70).
       01  ORDRMAPO REDEFINES ORDRMAPI.
           02  FILLER PIC X(12).
           02  FILLER PIC X(3).
           02  ORDIDO  PIC X(10).
           02  FILLER PIC X(3).
           02  ORDSTATO  PIC X(1).
           02  FILLER PIC X(3).
           02  ORDTOTO  PIC Z,ZZZ,ZZ9.99.
           02  FILLER PIC X(3).
           02  ORDMSGO  PIC X(70).
