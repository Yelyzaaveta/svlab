import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE } from './lib/db.js';
import { json, parseBody } from './lib/http.js';

export const create = async (event) => {
  try {
    const body = parseBody(event);
    const { orgId, name, description } = body;
    if (!orgId || !name) return json(422, { errors: ["orgId and name required"] });

    const now = new Date().toISOString();
    await ddb.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: TABLE,
               Item: { PK: `ORG#${orgId}`, SK: `ORG#${orgId}`,
                       name, description, version: 1, createdAt: now },
               ConditionExpression: 'attribute_not_exists(PK)' } },
      { Put: { TableName: TABLE,
               Item: { PK: `ORGNAME#${name.toLowerCase()}`, SK: "LOCK", orgId },
               ConditionExpression: 'attribute_not_exists(PK)' } },
    ] }));

    return json(201, { orgId, name, version: 1 });
  } catch (err) {
    if (err.name === 'TransactionCanceledException') {
      const [byId, byName] = err.CancellationReasons ?? [];
      const who = byId?.Code === 'ConditionalCheckFailed' ? 'orgId' : 'name';
      return json(409, { error: `${who} already exists` });
    }
    return json(err.statusCode ?? 500, { error: err.message });
  }
};
