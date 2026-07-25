// Apache Thrift IDL example — real-world shape: an Evernote NoteStore-style API.
//
// Hand-authored reconstruction of the shape of Evernote's public Thrift API
// (the NoteStore service with Note/Notebook types and EDAM exceptions); no
// third-party text was copied, and request wrappers stand in for the original
// multi-parameter methods.
namespace java com.example.edam

struct Notebook {
  1: string guid,
  2: string name,
  3: bool defaultNotebook,
  4: i64 serviceCreated,
  5: i64 serviceUpdated,
}

struct Note {
  1: string guid,
  2: string title,
  3: string content,
  4: i64 created,
  5: i64 updated,
  6: bool active,
  7: string notebookGuid,
  8: list<string> tagGuids,
}

struct NoteFilter {
  1: i32 order,
  2: bool ascending,
  3: string words,
  4: string notebookGuid,
}

struct NoteList {
  1: required i32 startIndex,
  2: required i32 totalNotes,
  3: required list<Note> notes,
}

exception EDAMUserException {
  1: required i32 errorCode,
  2: string parameter,
}

exception EDAMNotFoundException {
  1: string identifier,
  2: string key,
}

service NoteStore {
  Notebook getNotebook(
    1: string guid
  ) throws (1: EDAMNotFoundException e),

  list<Notebook> listNotebooks(),

  Note getNote(
    1: string guid
  ) throws (1: EDAMNotFoundException e),

  NoteList findNotes(
    1: NoteFilter filter
  ) throws (1: EDAMUserException ue),

  Note createNote(
    1: Note note
  ) throws (1: EDAMUserException ue),

  i32 getNoteCount(
    1: NoteFilter filter
  ),
}
