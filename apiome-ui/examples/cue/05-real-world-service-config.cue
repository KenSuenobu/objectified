// Platform configuration schema as a team ships one: a definition constraining every
// service's deployment settings, with defaults, cross-field constraints and an
// environment matrix. Reconstructed shape; no upstream text copied.
package platform

import "strings"

#Environment: "dev" | "staging" | "production"

#Resources: {
	cpu:    string & =~"^[0-9]+m$" | *"250m"
	memory: string & =~"^[0-9]+(Mi|Gi)$" | *"512Mi"
}

#Probe: {
	path:                string & =~"^/" | *"/healthz"
	initialDelaySeconds: int & >=0 | *10
	periodSeconds:       int & >0 | *10
	failureThreshold:    int & >0 | *3
}

#Ingress: {
	enabled: bool | *false
	host?:   string & =~"^[a-z0-9.-]+$"
	paths: [...string & =~"^/"] | *["/"]
	tls: bool | *true
}

#Service: {
	name:     string & strings.MinRunes(3) & strings.MaxRunes(40) & =~"^[a-z][a-z0-9-]*$"
	env:      #Environment
	image:    string & =~"^[a-z0-9./-]+:[a-zA-Z0-9._-]+$"
	replicas: int & >=1 & <=50 | *2
	port:     int & >=1024 & <=65535 | *8080

	resources: #Resources
	liveness:  #Probe
	readiness: #Probe & {path: string | *"/readyz"}
	ingress:   #Ingress

	envVars: [string]: string
	secrets: [...string]

	// Production services must have more than one replica.
	if env == "production" {
		replicas: >=2
	}
}

#Platform: {
	services: [Name=string]: #Service & {name: Name}
	defaults: #Resources
}

// A concrete instance validated by the schema above.
platform: #Platform & {
	defaults: {cpu: "500m", memory: "1Gi"}
	services: {
		orders: {
			env:      "production"
			image:    "registry.example.com/orders:2.3.0"
			replicas: 4
			resources: {cpu: "1000m", memory: "2Gi"}
			liveness: {}
			readiness: {periodSeconds: 5}
			ingress: {enabled: true, host: "api.example.com", paths: ["/v2/orders"]}
			envVars: {LOG_LEVEL: "info", REGION: "eu-west-1"}
			secrets: ["orders-db", "orders-signing-key"]
		}
		catalogue: {
			env:   "production"
			image: "registry.example.com/catalogue:1.9.4"
			resources: {}
			liveness: {}
			readiness: {}
			ingress: {enabled: true, host: "api.example.com", paths: ["/v2/products"]}
			envVars: {LOG_LEVEL: "warn"}
			secrets: []
		}
	}
}
