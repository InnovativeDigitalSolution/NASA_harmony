const { expect } = require('chai');
const sinon = require('sinon');
const { describe, it, before, after } = require('mocha');
const uuid = require('uuid');
const request = require('supertest');
const { hookServersStartStop } = require('../helpers/servers');
const { hookTransaction, hookTransactionFailure } = require('../helpers/db');
const { jobStatus, hookJobStatus, jobsEqual } = require('../helpers/jobs');
const Job = require('../../app/models/job');
const StubService = require('../helpers/stub-service');
const { hookRedirect, hookUrl } = require('../helpers/hooks');
const { hookRangesetRequest } = require('../helpers/ogc-api-coverages');
const { S3ObjectStore } = require('../../app/util/object-store');

const aJob = {
  username: 'joe',
  requestId: uuid().toString(),
  status: 'running',
  message: 'it is running',
  progress: 42,
  links: [{ href: 'http://example.com' }],
};

describe('Individual job status route', function () {
  hookServersStartStop({ skipEarthdataLogin: false });
  hookTransaction();
  before(async function () {
    await new Job(aJob).save(this.trx);
    this.trx.commit();
  });
  const jobId = aJob.requestId;
  describe('For a user who is not logged in', function () {
    before(async function () {
      this.res = await jobStatus(this.frontend, jobId).redirects(0);
    });
    it('redirects to Earthdata Login', function () {
      expect(this.res.statusCode).to.equal(307);
      expect(this.res.headers.location).to.include(process.env.OAUTH_HOST);
    });

    it('sets the "redirect" cookie to the originally-requested resource', function () {
      expect(this.res.headers['set-cookie'][0]).to.include(encodeURIComponent(`/jobs/${jobId}`));
    });
  });

  describe('For a logged-in user who owns the job', function () {
    hookJobStatus(jobId, 'joe');
    it('returns an HTTP success response', function () {
      expect(this.res.statusCode).to.equal(200);
    });

    it('returns a single job record in JSON format', function () {
      const actualJob = JSON.parse(this.res.text);
      expect(jobsEqual(actualJob, aJob)).to.be.true;
    });
  });

  describe('For a logged-in user who does not own the job', function () {
    hookJobStatus(jobId, 'jill');
    it('returns a 404 HTTP Not found response', function () {
      expect(this.res.statusCode).to.equal(404);
    });

    it('returns a JSON error response', function () {
      const response = JSON.parse(this.res.text);
      expect(response).to.eql({
        code: 'harmony:NotFoundError',
        description: `Error: Unable to find job ${jobId}` });
    });
  });

  describe('For a non-existent job ID', function () {
    const unknownRequest = uuid();
    hookJobStatus(unknownRequest, 'joe');
    it('returns a 404 HTTP Not found response', function () {
      expect(this.res.statusCode).to.equal(404);
    });

    it('returns a JSON error response', function () {
      const response = JSON.parse(this.res.text);
      expect(response).to.eql({
        code: 'harmony:NotFoundError',
        description: `Error: Unable to find job ${unknownRequest}` });
    });
  });

  describe('For an invalid job ID format', function () {
    hookJobStatus('not-a-uuid', 'joe');
    it('returns a 404 HTTP Not found response', function () {
      expect(this.res.statusCode).to.equal(400);
    });

    it('returns a JSON error response', function () {
      const response = JSON.parse(this.res.text);
      expect(response).to.eql({
        code: 'harmony:BadRequestError',
        description: 'Error: jobId not-a-uuid is in invalid format.',
      });
    });
  });

  describe('When the database catches fire', function () {
    hookTransactionFailure();
    describe('for a user that should have jobs', function () {
      hookJobStatus(jobId, 'joe');
      it('returns an internal server error status code', function () {
        expect(this.res.statusCode).to.equal(500);
      });
      it('includes an error message in JSON format indicating a server error', function () {
        const response = JSON.parse(this.res.text);
        expect(response).to.eql({
          code: 'harmony:ServerError',
          description: `Error: Internal server error trying to retrieve job status for job ${jobId}`,
        });
      });
    });
  });

  describe('status updates from non-HTTP backends', function () {
    const collection = 'C1215669046-GES_DISC';
    const variableName = 'CloudFrc_A';
    const version = '1.0.0';
    describe('when the job has started but not completed', function () {
      StubService.hook({ params: { status: 'successful' } });
      hookRangesetRequest(version, collection, variableName, {}, 'jdoe1');

      describe('retrieving its job status', function () {
        hookRedirect('jdoe1');

        it('returns a status field of "running"', function () {
          const job = JSON.parse(this.res.text);
          expect(job.status).to.eql('running');
        });

        it('returns a human-readable message field corresponding to its state', function () {
          const job = JSON.parse(this.res.text);
          expect(job.message).to.include('the request has been limited to process');
        });
      });
    });

    describe('when the job has failed to complete', function () {
      StubService.hook({ params: { error: 'something broke' } });
      hookRangesetRequest(version, collection, variableName, {}, 'jdoe2');
      before(async function () {
        await this.service.complete();
      });

      describe('retrieving its job status', function () {
        hookRedirect('jdoe2');

        it('returns a status field of "failed"', function () {
          const job = JSON.parse(this.res.text);
          expect(job.status).to.eql('failed');
        });

        it('returns a human-readable message field corresponding to its state', function () {
          const job = JSON.parse(this.res.text);
          expect(job.message).to.eql('something broke');
        });
      });
    });

    describe('when the job has completed successfully', function () {
      StubService.hook({ params: { status: 'successful' } });
      hookRangesetRequest(version, collection, variableName, {}, 'jdoe3');
      before(async function () {
        await this.service.complete();
      });

      describe('retrieving its job status', function () {
        hookRedirect('jdoe3');

        it('returns a status field of "successful"', function () {
          const job = JSON.parse(this.res.text);
          expect(job.status).to.eql('successful');
        });

        it('returns a human-readable message field corresponding to its state', function () {
          const job = JSON.parse(this.res.text);
          expect(job.message).to.include('the request has been limited to process');
        });
      });
    });
  });

  describe('status updates from HTTP backends', function () {
    const collection = 'C1104-PVC_TS2';
    const variableName = 'all';
    const version = '1.0.0';

    describe('when the job has started but not completed', function () {
      hookRangesetRequest(version, collection, variableName, {}, 'jdoe1');

      describe('retrieving its job status', function () {
        hookRedirect('jdoe1');

        it('returns a status field of "running"', function () {
          const job = JSON.parse(this.res.text);
          expect(job.status).to.eql('running');
        });

        it('returns a human-readable message field corresponding to its state', function () {
          const job = JSON.parse(this.res.text);
          expect(job.message).to.include('the request has been limited to process');
        });
      });
    });

    describe('when the job has failed to complete', function () {
      hookRangesetRequest(version, collection, variableName, {}, 'jdoe2');
      before(async function () {
        const id = this.res.headers.location.split('/').pop();
        await request(this.frontend)
          .get('/example/status').query({ id, error: 'something broke' });
      });

      describe('retrieving its job status', function () {
        hookRedirect('jdoe2');

        it('returns a status field of "failed"', function () {
          const job = JSON.parse(this.res.text);
          expect(job.status).to.eql('failed');
        });

        it('returns a human-readable message field corresponding to its state', function () {
          const job = JSON.parse(this.res.text);
          expect(job.message).to.eql('something broke');
        });
      });
    });

    describe('when an incomplete job has provided links as a partial status updates', function () {
      const links = [
        {
          href: 'http://example.com/1',
          title: 'Example 1',
          type: 'text/plain',
        },
        {
          href: 'http://example.com/2',
          title: 'Example 2',
          type: 'text/ornate',
        },
      ];

      StubService.hook({ params: { status: 'successful' } });
      hookRangesetRequest(version, collection, variableName, {}, 'jdoe1');
      before(async function () {
        await this.service.sendResponse({ item: links[0] });
        await this.service.sendResponse({ item: links[1] });
      });
      hookRedirect('jdoe1');

      it('returns the links in its response', function () {
        const job = JSON.parse(this.res.text);
        expect(job.links).to.eql(links);
      });

      it('maintains a status of "running"', function () {
        const job = JSON.parse(this.res.text);
        expect(job.status).to.equal('running');
      });
    });

    describe('when an incomplete job has provided a percentage progress update', function () {
      StubService.hook({ params: { status: 'successful' } });
      hookRangesetRequest(version, collection, variableName, {}, 'jdoe1');
      before(async function () {
        await this.service.sendResponse({ progress: 20 });
      });
      hookRedirect('jdoe1');

      it('displays the progress in its response', function () {
        const job = JSON.parse(this.res.text);
        expect(job.progress).to.equal(20);
      });

      it('maintains a status of "running"', function () {
        const job = JSON.parse(this.res.text);
        expect(job.status).to.equal('running');
      });
    });

    describe('when an incomplete job provides an out-of-range percentage', function () {
      StubService.hook({ params: { status: 'successful' } });
      hookRangesetRequest(version, collection, variableName, {}, 'jdoe1');
      before(async function () {
        this.res = await this.service.sendResponse({ progress: -1 }).ok(() => true);
      });

      it('rejects the update', async function () {
        expect(this.res.status).to.equal(400);
        const body = JSON.parse(this.res.text);
        expect(body.message).to.equal('Job record is invalid: ["Job progress must be between 0 and 100"]');
      });
    });

    describe('when an incomplete job provides a non-numeric percentage', function () {
      StubService.hook({ params: { status: 'successful' } });
      hookRangesetRequest(version, collection, variableName, {}, 'jdoe1');
      before(async function () {
        this.res = await this.service.sendResponse({ progress: 'garbage' }).ok(() => true);
      });

      it('rejects the update', async function () {
        expect(this.res.status).to.equal(400);
        const body = JSON.parse(this.res.text);
        expect(body.message).to.equal('Job record is invalid: ["Job progress must be between 0 and 100"]');
      });
    });

    describe('when a job has provided an S3 URL as a result', function () {
      const s3Uri = 's3://example-bucket/public/example/path.tif';
      StubService.hook({ params: { status: 'successful' } });
      hookRangesetRequest(version, collection, variableName, {}, 'jdoe1');
      before(async function () {
        await this.service.sendResponse({ item: { href: s3Uri } });
      });
      hookRedirect('jdoe1');

      it('provides a permanent link to a Harmony HTTP URL', function () {
        const job = JSON.parse(this.res.text);
        expect(job.links[0].href).to.match(/^http/);
        expect(job.links[0].href).to.have.string('/service-results/example-bucket/public/example/path.tif');
      });

      describe('loading the provided Harmony HTTP URL', function () {
        before(function () {
          sinon.stub(S3ObjectStore.prototype, 'signGetObject')
            .callsFake((url, params) => `https://example.com/signed/${params['x-user']}`);
        });
        after(function () {
          S3ObjectStore.prototype.signGetObject.restore();
        });

        hookUrl(function () {
          return JSON.parse(this.res.text).links[0].href.split(/:\d+/)[1];
        }, 'jdoe1');

        it('temporarily redirects to a presigned URL for the data', function () {
          expect(this.res.statusCode).to.equal(307);
          expect(this.res.headers.location).to.equal('https://example.com/signed/jdoe1');
        });
      });
    });

    describe('when the job has completed successfully', function () {
      hookRangesetRequest(version, collection, variableName, {}, 'jdoe3');
      before(async function () {
        const id = this.res.headers.location.split('/').pop();
        await request(this.frontend)
          .get('/example/status').query({ id, status: 'successful' });
      });

      describe('retrieving its job status', function () {
        hookRedirect('jdoe3');

        it('returns a status field of "successful"', function () {
          const job = JSON.parse(this.res.text);
          expect(job.status).to.eql('successful');
        });

        it('returns a human-readable message field corresponding to its state', function () {
          const job = JSON.parse(this.res.text);
          expect(job.message).to.include('the request has been limited to process');
        });
      });
    });
  });
});