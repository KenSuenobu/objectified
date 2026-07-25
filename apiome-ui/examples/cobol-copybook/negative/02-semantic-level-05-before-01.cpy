      *****************************************************************
      * COBOL copybook - shipment record whose elementary items appear
      * BEFORE the level-01 group that should own them. Each entry is
      * well-formed, but a copybook must begin with a level-01 item.
      *****************************************************************
           05  SHIP-TO-NAME              PIC X(30).
           05  SHIP-TO-CITY              PIC X(20).
       01  SHIPMENT-RECORD.
           05  SHIPMENT-ID               PIC 9(9).
           05  SHIPMENT-DATE             PIC 9(8).
