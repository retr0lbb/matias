export interface CreateAsaasCustomerInput {
	name: string;
	/** CPF or CNPJ; punctuation is stripped before sending. */
	cpfCnpj: string;
	email?: string;
	mobilePhone?: string;
	/** Identifier of the customer in our system (e.g. the user id). */
	externalReference?: string;
	notificationDisabled?: boolean;
}

export interface AsaasCustomer {
	object: "customer";
	/** Asaas customer id, e.g. `cus_000005401844`. */
	id: string;
	dateCreated: string;
	name: string;
	cpfCnpj: string;
	personType: "FISICA" | "JURIDICA";
	email?: string | null;
	mobilePhone?: string | null;
	externalReference?: string | null;
	notificationDisabled: boolean;
	deleted: boolean;
}

export interface AsaasErrorResponse {
	errors: { code: string; description: string }[];
}
