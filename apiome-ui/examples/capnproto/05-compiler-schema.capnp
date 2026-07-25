# Cap'n Proto schema example — real-world shape: the compiler bootstrap schema.
#
# Hand-authored reconstruction of the shape of Cap'n Proto's own schema.capnp
# (Node / Field / CodeGeneratorRequest, the schema handed to compiler
# plugins); no third-party text was copied and the surface is simplified.
@0xc90fa3d8b12e6754;

struct Node {
  id @0 :UInt64;
  displayName @1 :Text;
  scopeId @2 :UInt64;
  nestedNodes @3 :List(NestedNode);
  kind @4 :Kind;

  struct NestedNode {
    name @0 :Text;
    id @1 :UInt64;
  }

  enum Kind {
    file @0;
    structNode @1;
    enumNode @2;
    interfaceNode @3;
    constNode @4;
    annotationNode @5;
  }
}

struct Field {
  name @0 :Text;
  codeOrder @1 :UInt16;
  discriminantValue @2 :UInt16;
  offset @3 :UInt32;
  typeName @4 :Text;
}

struct RequestedFile {
  id @0 :UInt64;
  filename @1 :Text;
}

struct CodeGeneratorRequest {
  nodes @0 :List(Node);
  requestedFiles @1 :List(RequestedFile);
}
