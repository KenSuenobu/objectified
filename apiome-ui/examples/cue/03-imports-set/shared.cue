// Imported package: the value types the root's definitions unify with.
package shared

#Address: {
	line1:       string
	line2?:      string
	city:        string
	postalCode:  string
	countryCode: string & =~"^[A-Z]{2}$"
}

#Money: {
	value:    int & >=0
	currency: "EUR" | "GBP" | "USD"
}
