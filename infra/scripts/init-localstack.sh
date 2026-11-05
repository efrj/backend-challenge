#!/bin/sh
set -e

WAGER_QUEUE="${SQS_WAGER_QUEUE_NAME:-wager-transactions.fifo}"
DLQ_QUEUE="${SQS_WAGER_DLQ_NAME:-wager-transactions-dlq.fifo}"
EVENTS_QUEUE="${SQS_EVENTS_QUEUE_NAME:-wager-integration-events.fifo}"
MAX_RECEIVE="${SQS_MAX_RECEIVE_COUNT:-3}"
VISIBILITY="${SQS_VISIBILITY_TIMEOUT_SEC:-30}"

echo "Initializing LocalStack SQS FIFO queues..."

awslocal sqs create-queue \
  --queue-name "$DLQ_QUEUE" \
  --attributes "FifoQueue=true,ContentBasedDeduplication=false"

DLQ_URL=$(awslocal sqs get-queue-url \
  --queue-name "$DLQ_QUEUE" \
  --query 'QueueUrl' \
  --output text)

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' \
  --output text)

awslocal sqs create-queue \
  --queue-name "$WAGER_QUEUE" \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"${VISIBILITY}\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"${MAX_RECEIVE}\\\"}\"}"

awslocal sqs create-queue \
  --queue-name "$EVENTS_QUEUE" \
  --attributes "FifoQueue=true,ContentBasedDeduplication=false"

echo "LocalStack SQS queues initialized successfully."
