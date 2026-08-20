// Root of the set: imports the shared package and constrains a shipment with it.
package shipping

import "example.com/shared:shared"

#Shipment: {
	shipmentId:  string & =~"^SHP-[0-9]{6}$"
	destination: shared.#Address
	price:       shared.#Money
	weightKg:    float & >0
	parcels: [...{parcelId: string, fragile: bool | *false}] & [_, ...]
}
