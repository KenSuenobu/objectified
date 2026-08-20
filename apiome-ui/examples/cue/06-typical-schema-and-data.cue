// Schema and conforming data in one file: the CUE idiom where a definition is applied to
// concrete values by unification, so evaluation both validates and completes the data.
package catalogue

#Product: {
	sku:          string & =~"^[A-Z]{3}-[0-9]{4}$"
	name:         string
	price:        number & >0
	currency:     "EUR" | *"EUR"
	discontinued: bool | *false
	tags: [...string]
}

#Catalogue: {
	version: string
	products: [...#Product]
}

catalogue: #Catalogue & {
	version: "2026.08"
	products: [
		{sku: "WID-0001", name: "Stainless widget 40mm", price: 180.0, tags: ["hardware"]},
		{sku: "GAD-0007", name: "Gadget, boxed", price: 42.0, tags: ["hardware", "boxed"]},
		{sku: "BRK-0020", name: "Bracket", price: 1.5, discontinued: true, tags: []},
	]
}
