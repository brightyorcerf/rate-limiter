const TokenBucket = require('../src/algorithms/tokenBucket');

// test 1
console.log('test 1: basic consumption');
const bucket = new TokenBucket(5, 1); // 5 capacity, 1 token/second
console.log('initial state:', bucket.getState());
console.log('request 1:', bucket.consume() ? 'ALLOWED' : 'REJECTED');
console.log('after 1 request:', bucket.getState());

// test 2
console.log('\ntest 2: burst then exhaust');
const bucket2 = new TokenBucket(3, 1);
console.log('request 1:', bucket2.consume() ? 'ALLOWED' : 'REJECTED');
console.log('request 2:', bucket2.consume() ? 'ALLOWED' : 'REJECTED');
console.log('request 3:', bucket2.consume() ? 'ALLOWED' : 'REJECTED');
console.log('request 4:', bucket2.consume() ? 'ALLOWED' : 'REJECTED'); // should fail
console.log('retry after:', bucket2.getRetryAfter(), 'ms');

// test 3 
console.log('\ntest 3: refill over time');
const bucket3 = new TokenBucket(2, 1);
bucket3.consume(); // use 1 token
bucket3.consume(); // use 1 token (empty now)
console.log('state after using all tokens:', bucket3.getState());

setTimeout(() => {
  console.log('after 1 second:', bucket3.getState());
  console.log('can make request?', bucket3.consume() ? 'YES' : 'NO');
}, 1100);