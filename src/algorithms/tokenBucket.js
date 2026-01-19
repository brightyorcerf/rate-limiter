class TokenBucket{
    /**
     * @param {number} capacity - maximum tokens bucket can hold (burst size)
     * @param {number} refillRate - tokens added per second
     */
    //above part is JSDoc comment 

    constructor(capacity, refillRate){
        this.capacity = capacity
        this.refillRate = refillRate
        this.tokens = capacity
        this.lastRefill = Date.now()
    }

    refill(){
        const now = Date.now()
        const timePassed  = (now - this.lastRefill) / 1000 //converting to seconds

        const tokensToAdd = timePassed * this.refillRate
        this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd)
        this.lastRefill = now
    }

    consume(tokens = 1){
        this.refill()
        if(this.tokens >= tokens){
            this.tokens -= tokens
            return true
        }
        return false
    }

    getState(){
        this.refill(); // update tokens first
        return{
            tokens: Math.floor(this.tokens),
            capacity: this.capacity,
            refillRate: this.refillRate,
            timeUntilRefill: this.tokens < this.capacity 
                ? ((1 - (this.tokens % 1)) / this.refillRate) * 1000 
                : 0
        }
    }

  /**
   * calculate when bucket will've enough tokens
   * @param {number} needed - tokens needed
   * @returns {number} - milliseconds until available
   */
  getRetryAfter(needed = 1) {
    this.refill();
    
    if (this.tokens >= needed) {
      return 0;  
    }
    
    const tokensNeeded = needed - this.tokens;
    const secondsNeeded = tokensNeeded / this.refillRate;
    return Math.ceil(secondsNeeded * 1000); // convert to milliseconds
  }
}

module.exports = TokenBucket; 
