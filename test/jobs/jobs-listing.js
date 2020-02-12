const { expect } = require('chai');
const { describe, it, before } = require('mocha');
const { hookServersStartStop } = require('../helpers/servers');
const { hookTransaction } = require('../helpers/db');
const { woodyJob1, woodyJob2, buzzJob1, containsJob, jobListing, hookJobListing } = require('../helpers/jobs');
const Job = require('../../app/models/job');

describe('Jobs listing route', function () {
  hookServersStartStop({ skipEarthdataLogin: false });
  describe('For a user who is not logged in', function () {
    before(async function () {
      this.res = await jobListing(this.frontend).redirects(0);
    });
    it('redirects to Earthdata Login', function () {
      expect(this.res.statusCode).to.equal(307);
      expect(this.res.headers.location).to.include(process.env.OAUTH_HOST);
    });

    it('sets the "redirect" cookie to the originally-requested resource', function () {
      expect(this.res.headers['set-cookie'][0]).to.include(encodeURIComponent('/jobs'));
    });
  });

  describe('For a logged-in user', function () {
    hookTransaction();
    before(async function () {
      // Add all jobs to the database
      await new Job(woodyJob1).save(this.trx);
      await new Job(woodyJob2).save(this.trx);
      await new Job(buzzJob1).save(this.trx);
      this.trx.commit();
    });

    describe('Who has no jobs', function () {
      hookJobListing('andy');
      it('returns an HTTP success response', function () {
        expect(this.res.statusCode).to.equal(200);
      });

      it('returns an empty JSON job list', function () {
        expect(JSON.parse(this.res.text)).to.eql([]);
      });
    });

    describe('Who has jobs', function () {
      hookJobListing('woody');
      it('returns an HTTP success response', function () {
        expect(this.res.statusCode).to.equal(200);
      });

      it('returns a list of the user’s job records in JSON format', function () {
        const listing = JSON.parse(this.res.text);
        expect(containsJob(woodyJob1, listing)).to.be.true;
        expect(containsJob(woodyJob2, listing)).to.be.true;
      });
      it('does not return jobs for other users', function () {
        const listing = JSON.parse(this.res.text);
        expect(containsJob(buzzJob1, listing)).to.be.false;
      });
    });
  });
});
