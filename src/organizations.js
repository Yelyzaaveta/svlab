import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE } from './lib/db.js';
import { json, parseBody } from './lib/http.js';
import { validateVersion } from './lib/validate.js';

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

// PUT /organizations/{orgId}
export const update = async (event) => {
  try {
    const { orgId } = event.pathParameters;
    const body = parseBody(event);
    const { name, description, version } = body;
    const errors = [];
    if (!name || name.length > 100) errors.push('name is required, max 100 chars');
    errors.push(...validateVersion(version));
    if (errors.length) return json(422, { errors });

    const Key = { PK: `ORG#${orgId}`, SK: `ORG#${orgId}` };
    const { Item: current } = await ddb.send(new GetCommand({ TableName: TABLE, Key }));
    if (!current) return json(404, { error: 'organization not found' });

    // attribute_exists(PK) — PUT не створює ресурс мовчки;
    // version = :expected — оптимістичне блокування.
    const orgUpdate = {
      TableName: TABLE,
      Key,
      UpdateExpression: 'SET #n = :n, description = :d, version = :next, updatedAt = :t',
      ConditionExpression: 'attribute_exists(PK) AND version = :expected',
      ExpressionAttributeNames: { '#n': 'name' },
      ExpressionAttributeValues: {
        ':n': name, ':d': description ?? null, ':expected': version,
        ':next': version + 1, ':t': new Date().toISOString() },
    };

    const oldLock = current.name.toLowerCase();
    const newLock = name.toLowerCase();
    if (oldLock === newLock) {
      await ddb.send(new UpdateCommand(orgUpdate));
    } else {
      // назва змінилася — переносимо замок назви в тій самій транзакції.
      await ddb.send(new TransactWriteCommand({ TransactItems: [
        { Update: orgUpdate },
        { Put: { TableName: TABLE,
            Item: { PK: `ORGNAME#${newLock}`, SK: 'LOCK', orgId },
            ConditionExpression: 'attribute_not_exists(PK)' } },
        { Delete: { TableName: TABLE,
            Key: { PK: `ORGNAME#${oldLock}`, SK: 'LOCK' } } },
      ] }));
    }

    return json(200, { orgId, name, description, version: version + 1 });
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      return json(409, { error: 'version is stale' });
    }
    if (err.name === 'TransactionCanceledException') {
      const [org, lock] = err.CancellationReasons ?? [];
      if (org?.Code === 'ConditionalCheckFailed') return json(409, { error: 'version is stale' });
      if (lock?.Code === 'ConditionalCheckFailed') return json(409, { error: 'name already exists' });
    }
    return json(err.statusCode ?? 500, { error: err.message });
  }
};

// GET /organizations/{orgId} — організація + користувачі одним Query за PK.
export const get = async (event) => {
  try {
    const { orgId } = event.pathParameters;
    const items = [];
    let ExclusiveStartKey;
    do {
      const page = await ddb.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': `ORG#${orgId}` },
        ExclusiveStartKey,
      }));
      items.push(...page.Items);
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);

    const strip = ({ PK, SK, ...rest }) => rest;
    const org = items.find((i) => i.SK.startsWith('ORG#'));
    if (!org) return json(404, { error: 'organization not found' });

    const users = items
      .filter((i) => i.SK.startsWith('USER#') && !i.deletedAt)
      .map(strip);

    return json(200, { orgId, ...strip(org), users });
  } catch (err) {
    return json(err.statusCode ?? 500, { error: err.message });
  }
};
