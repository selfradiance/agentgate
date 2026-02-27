const baseUrl = "http://localhost:3000";
const failures: string[] = [];

async function post(path: string, body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(JSON.stringify(data));
  }

  return data as Record<string, unknown>;
}

async function main() {
  const identity = await post("/v1/identities", {
    publicKey: `pk_spam_${Date.now()}`
  });

  const identityId = String(identity.identityId);
  let actionsCreated = 0;

  for (let index = 0; index < 20; index += 1) {
    try {
      const bond = await post("/v1/bonds/lock", {
        identityId,
        amountCents: 1000,
        currency: "USD",
        ttlSeconds: 300,
        reason: "spam simulation"
      });

      await post("/v1/actions/execute", {
        identityId,
        actionType: "spam-action",
        payload: {
          attempt: index + 1
        },
        bondId: String(bond.bondId)
      });

      actionsCreated += 1;
    } catch (error) {
      failures.push(`action ${index + 1}: ${String(error)}`);
    }
  }

  console.log("Actions created:", actionsCreated);
  console.log("Total capital locked:", 20 * 1000);
  console.log("Failures:", failures);
}

void main();
