import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE } from './lib/db.js';
import { json, parseBody } from './lib/http.js';
import { validateUser, validateVersion } from './lib/validate.js';

const failed = (reason) => reason?.Code === 'ConditionalCheckFailed';

// POST /organizations/{orgId}/users
export const create = async (event) => {
  try {
    const { orgId } = event.pathParameters;
    const body = parseBody(event);
    const errors = validateUser(body);
    if (errors.length) return json(422, { errors });

    const { userId, name } = body;
    const email = body.email.toLowerCase();
    const now = new Date().toISOString();

    // Одна транзакція: організація існує + userId вільний + email вільний.
    await ddb.send(new TransactWriteCommand({ TransactItems: [
      { ConditionCheck: { TableName: TABLE,
          Key: { PK: `ORG#${orgId}`, SK: `ORG#${orgId}` },
          ConditionExpression: 'attribute_exists(PK)' } },
      { Put: { TableName: TABLE,
          Item: { PK: `ORG#${orgId}`, SK: `USER#${userId}`,
                  userId, name, email, version: 1, createdAt: now },
          ConditionExpression: 'attribute_not_exists(PK)' } },
      { Put: { TableName: TABLE,
          Item: { PK: `EMAIL#${email}`, SK: 'LOCK', orgId, userId },
          ConditionExpression: 'attribute_not_exists(PK)' } },
    ] }));

    return json(201, { orgId, userId, name, email, version: 1 });
  } catch (err) {
    if (err.name === 'TransactionCanceledException') {
      const [org, user, email] = err.CancellationReasons ?? [];
      if (failed(org)) return json(404, { error: 'organization not found' });
      if (failed(user)) return json(409, { error: 'userId already exists' });
      if (failed(email)) return json(409, { error: 'email already taken' });
    }
    return json(err.statusCode ?? 500, { error: err.message });
  }
};

// PUT /organizations/{orgId}/users/{userId}
export const update = async (event) => {
  try {
    const { orgId, userId } = event.pathParameters;
    const body = parseBody(event);
    const errors = [
      ...validateUser({ ...body, userId }),
      ...validateVersion(body.version),
    ];
    if (errors.length) return json(422, { errors });

    const { name, version } = body;
    const email = body.email.toLowerCase();
    const Key = { PK: `ORG#${orgId}`, SK: `USER#${userId}` };

    const { Item: current } = await ddb.send(new GetCommand({ TableName: TABLE, Key }));
    if (!current || current.deletedAt) return json(404, { error: 'user not found' });

    // attribute_exists(PK) — PUT не створює ресурс мовчки;
    // version = :expected — оптимістичне блокування.
    const userUpdate = {
      TableName: TABLE,
      Key,
      UpdateExpression: 'SET #n = :n, email = :e, version = :next, updatedAt = :t',
      ConditionExpression:
        'attribute_exists(PK) AND attribute_not_exists(deletedAt) AND version = :expected',
      ExpressionAttributeNames: { '#n': 'name' },
      ExpressionAttributeValues: {
        ':n': name, ':e': email, ':expected': version,
        ':next': version + 1, ':t': new Date().toISOString() },
    };

    if (email === current.email) {
      await ddb.send(new UpdateCommand(userUpdate));
    } else {
      // email змінився — переносимо замок у тій самій транзакції.
      await ddb.send(new TransactWriteCommand({ TransactItems: [
        { Update: userUpdate },
        { Put: { TableName: TABLE,
            Item: { PK: `EMAIL#${email}`, SK: 'LOCK', orgId, userId },
            ConditionExpression: 'attribute_not_exists(PK)' } },
        { Delete: { TableName: TABLE,
            Key: { PK: `EMAIL#${current.email}`, SK: 'LOCK' } } },
      ] }));
    }

    return json(200, { orgId, userId, name, email, version: version + 1 });
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      return json(409, { error: 'version is stale' });
    }
    if (err.name === 'TransactionCanceledException') {
      const [user, email] = err.CancellationReasons ?? [];
      if (failed(user)) return json(409, { error: 'version is stale' });
      if (failed(email)) return json(409, { error: 'email already taken' });
    }
    return json(err.statusCode ?? 500, { error: err.message });
  }
};

// DELETE /organizations/{orgId}/users/{userId} — м'яке видалення (варіант 2).
const TTL_DAYS = 30;

export const remove = async (event) => {
  try {
    const { orgId, userId } = event.pathParameters;
    const Key = { PK: `ORG#${orgId}`, SK: `USER#${userId}` };

    const { Item: current } = await ddb.send(new GetCommand({ TableName: TABLE, Key }));
    if (!current || current.deletedAt) return json(404, { error: 'user not found' });

    const now = new Date();
    const deletedAt = now.toISOString();
    const ttl = Math.floor(now.getTime() / 1000) + TTL_DAYS * 24 * 60 * 60;

    await ddb.send(new TransactWriteCommand({ TransactItems: [
      { Update: { TableName: TABLE, Key,
          UpdateExpression: 'SET deletedAt = :d, #ttl = :ttl',
          ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(deletedAt)',
          ExpressionAttributeNames: { '#ttl': 'ttl' },   
          ExpressionAttributeValues: { ':d': deletedAt, ':ttl': ttl } } },
      { Delete: { TableName: TABLE,
          Key: { PK: `EMAIL#${current.email}`, SK: 'LOCK' },
          ConditionExpression: 'orgId = :o AND userId = :u',
          ExpressionAttributeValues: { ':o': orgId, ':u': userId } } },
    ] }));

    return json(200, { orgId, userId, deletedAt, ttl });
  } catch (err) {
    if (err.name === 'TransactionCanceledException') {
      const [user] = err.CancellationReasons ?? [];
      if (failed(user)) return json(404, { error: 'user not found' });
      return json(409, { error: 'email lock does not belong to this user' });
    }
    return json(err.statusCode ?? 500, { error: err.message });
  }
};
