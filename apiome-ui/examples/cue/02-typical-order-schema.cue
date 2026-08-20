package orders

#OrderStatus: "new" | "paid" | "shipped" | "cancelled"

#Money: {
	value:    int & >=0
	currency: "EUR" | "GBP" | "USD"
}

#OrderLine: {
	sku:       string & =~"^[A-Z]{3}-[0-9]{4}$"
	quantity:  int & >0 & <=9999
	unitPrice: #Money
	discount?: float & >=0.0 & <=1.0
}

#Order: {
	orderId:    string & =~"^ORD-[0-9]{8}$"
	customerId: string & strings.MinRunes(3) & strings.MaxRunes(20)
	status:     #OrderStatus | *"new"
	placedAt:   string
	lines: [...#OrderLine] & [_, ...]
	total: #Money
	note?: string & strings.MaxRunes(500)
}

import "strings"
