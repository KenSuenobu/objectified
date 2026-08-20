package broken

// Unification of two incompatible constraints: the lattice bottoms out, so evaluation
// fails with a conflict rather than producing a value.
#Port: int & >1024 & <100

#Name: string & "fixed" & "other"

value: #Port
label: #Name
