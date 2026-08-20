package stress

import (
	"strings"
	"list"
)

// ---------------------------------------------------------------- expressible

#Scalars: {
	text:     string
	bounded:  string & strings.MinRunes(2) & strings.MaxRunes(64)
	pattern:  string & =~"^[a-z0-9-]+$"
	count:    int & >=0 & <=100
	exclusive: number & >0 & <1
	ratio:    float
	flag:     bool
	blob:     bytes
	nothing:  null
	anything: _
}

#Enum: "alpha" | "beta" | "gamma"

#WithDefaults: {
	// The * marks the default branch of a disjunction.
	mode:    "fast" | *"safe" | "thorough"
	retries: int | *3
	label:   string | *"unnamed"
}

#Collections: {
	list: [...string]
	nonEmpty: [_, ...int]
	fixed: [string, int, bool]
	bounded: list.MaxItems(10) & [...#Enum]
	table: [string]: int
	nested: [string]: [...{name: string, value: number}]
}

#Closed: {
	only: string
}

#Open: {
	known: string
	...
}

#Embedded: {
	#Closed
	extra: int
}

// Unification: the result is the greatest lower bound of both operands.
#Narrowed: #Scalars & {
	count: >=10
	flag:  true
}

// ---------------------------------------------------------------- declared limits

// Comprehension: values computed from other values.
#Computed: {
	inputs: [...string]
	upper: [for s in inputs {strings.ToUpper(s)}]
	count: len(inputs)
}

// Conditional field: presence depends on another field's value.
#Conditional: {
	tier: "free" | "paid"
	if tier == "paid" {
		seats: int & >0
	}
	if tier == "free" {
		seats: 1
	}
}

// Hidden fields and let bindings exist only during evaluation.
#Hidden: {
	_secret: string
	let doubled = 2
	visible: int & >=doubled
}

// Recursive definition: a lattice value that refers to itself.
#Tree: {
	name: string
	children: [...#Tree]
}

// Alias and interpolation: string values built from other fields.
#Interpolated: {
	host:   string
	port:   int
	target: "\(host):\(port)"
}
