-- Within-document composition: record types combined with //\\, schema records built
-- from other schema records, and a specialisation that overrides one default.

let Timestamps = { createdAt : Text, updatedAt : Optional Text }

let Identified = { id : Text }

let Base = Identified //\\ Timestamps

let Record = Base //\\ { label : Text }

let RecordSchema =
      { Type = Record
      , default = { updatedAt = None Text, label = "" }
      }

let ActiveRecord =
      { Type = Record //\\ { status : Text }
      , default = RecordSchema.default /\ { status = "active" }
      }

let ArchivedRecord =
      { Type = Record //\\ { status : Text, archivedAt : Text }
      , default = RecordSchema.default /\ { status = "archived" }
      }

let AnyRecord = < Active : ActiveRecord.Type | Archived : ArchivedRecord.Type >

in  { Timestamps, Identified, Base, Record, RecordSchema, ActiveRecord, ArchivedRecord, AnyRecord }
