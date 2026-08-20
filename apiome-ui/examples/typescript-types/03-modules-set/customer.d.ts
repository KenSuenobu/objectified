export interface Address {
  line1: string;
  line2?: string;
  city: string;
  postalCode: string;
  countryCode: string;
}

export interface Customer {
  customerId: string;
  displayName: string;
  email: string;
  address?: Address;
  segments: string[];
}
