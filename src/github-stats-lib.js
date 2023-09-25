const { Octokit } = require('octokit');
const fs = require('fs');
require('dotenv').config();

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

async function getPullRequests (octokit, owner, repo, dateFrom, dateTo) {
    const iterator = await octokit.paginate.iterator('GET /repos/{owner}/{repo}/pulls?state=all', {
        owner,
        repo,
        per_page: 100,
        headers: {
            'X-GitHub-Api-Version': '2022-11-28'
        }
    });

    let prs = [];
    for await (const { data } of iterator) {
        prs = [...prs, ...data.filter(pr => filterPullRequestList(pr, dateFrom, dateTo))];
    }

    return prs;
}

async function getReviews (octokit, owner, repo, pullId) {
    const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
        pull_number: pullId,
        owner,
        repo,
        headers: {
            'X-GitHub-Api-Version': '2022-11-28'
        }
    });

    return { pull_number: pullId, reviews: response.data };
}

function getDetailedStats (pullRequests, dateFrom, dateTo) {
    let grouped = [];
    grouped = pullRequests.reduce((acc, pr) => {
        const key = `${pr.owner}/${pr.repo}/${pr.author}`;

        const validPullRequestInterval = new Date(pr.created_at) > dateFrom & new Date(pr.created_at) < dateTo;
        if (validPullRequestInterval) {
            if (!acc[key]) {
                acc[key] = { created: 0, commented: 0, approved: 0 };
            }

            acc[key].created += 1;
        }

        const reviewsCommented = {};
        const reviewsApproved = {};

        pr.reviews.forEach(review => {
            const validReviewInterval = new Date(review.submited_at) > dateFrom & new Date(review.submited_at) < dateTo;
            const alignReview = pr.author !== review.reviewer;

            if (validReviewInterval && alignReview) {
                const reviewerKey = `${pr.owner}/${pr.repo}/${review.reviewer}`;
                if (!acc[reviewerKey]) {
                    acc[reviewerKey] = { created: 0, commented: 0, approved: 0 };
                }

                if (review.state === 'COMMENTED' && !reviewsCommented[reviewerKey]) {
                    acc[reviewerKey].commented += 1;
                    reviewsCommented[reviewerKey] = true;
                } else if (review.state === 'APPROVED' && !reviewsApproved[reviewerKey]) {
                    acc[reviewerKey].approved += 1;
                    reviewsApproved[reviewerKey] = true;
                }
            }
        });

        return acc;
    }, {});

    grouped = Object.keys(grouped).map(key => {
        const [owner, repo, author] = key.split('/');
        return {
            owner,
            repo,
            author,
            ...grouped[key]
        };
    });

    return grouped;
}

function getSummary (stats) {
    const finalResult = stats.reduce((acc, item) => {
        if (!acc[item.author]) {
            acc[item.author] = {
                pull_requests: 0,
                repos: new Set(),
                commented: 0,
                approved: 0,
                reposReviewed: new Set()
            };
        }

        acc[item.author].pull_requests += item.created;

        if (item.created > 0) {
            acc[item.author].repos.add(`${item.owner}/${item.repo}`);
        }
        acc[item.author].commented += item.commented;
        acc[item.author].approved += item.approved;

        if (item.commented > 0 || item.approved > 0) {
            acc[item.author].reposReviewed.add(`${item.owner}/${item.repo}`);
        }

        return acc;
    }, {});

    const finalArray = Object.keys(finalResult).map(author => {
        return {
            author,
            pull_requests: finalResult[author].pull_requests,
            repos: finalResult[author].repos.size,
            commented: finalResult[author].commented,
            approved: finalResult[author].approved,
            repos_reviewed: finalResult[author].reposReviewed.size
        };
    });

    return finalArray;
}

function filterPullRequestList (pr, dateFrom, dateTo) {
    const open = pr.state === 'open';
    const createdAfter = new Date(pr.created_at) > dateFrom;
    const createdBefore = new Date(pr.created_at) < dateTo;
    return open || (createdAfter && createdBefore);
}

function displayProgress (progress, total, label) {
    const barLength = 60;
    const fill = Math.floor(progress * barLength / total);
    const progressBar = '[' + '■'.repeat(fill) + ' '.repeat(barLength - fill) + ']';
    process.stdout.write('\x1B[2K');
    process.stdout.write(`\r${progressBar} ${progress}/${total} ${label}`);
}

function displayDone (total) {
    const barLength = 60;
    const progressBar = '[' + '■'.repeat(barLength) + ']';
    process.stdout.write('\x1B[2K');
    process.stdout.write(`\r${progressBar} ${total}/${total} Done`);
    process.stdout.write('\n');
}

async function main (repos, dateFrom, dateTo, filename = '') {
    // Compare: https://docs.github.com/en/rest/reference/users#get-the-authenticated-user
    const {
        data: { login }
    } = await octokit.rest.users.getAuthenticated();
    console.log('Requesting on behalf of %s', login);

    console.log('Reading pull request list from repos');
    let prs = [];
    const total = repos.length;
    for (let progress = 0; progress < total; progress++) {
        const repo = repos[progress];

        displayProgress(progress + 1, total, `@${repo.owner}/${repo.repo}`);

        const pullRequests = await getPullRequests(octokit, repo.owner, repo.repo, dateFrom, dateTo);

        prs = [...prs, ...pullRequests.map(pr => ({
            owner: repo.owner,
            repo: repo.repo,
            number: pr.number,
            state: pr.state,
            created_at: pr.created_at,
            updated_at: pr.updated_at,
            closed_at: pr.closed_at,
            merged_at: pr.merged_at,
            author: pr.user.login,
            title: pr.title
        }))];
    }

    displayDone(total);
    console.log('Reading reviews from pull requests');

    for (let progress = 0; progress < prs.length; progress++) {
        const item = prs[progress];

        displayProgress(progress + 1, prs.length, `@${item.owner}/${item.repo}/pull/${item.number}`);

        const reviews = await getReviews(octokit, item.owner, item.repo, item.number);
        item.reviews = reviews.reviews.map(review => ({
            state: review.state,
            reviewer: review.user.login,
            submited_at: review.submitted_at
        }));
    }

    displayDone(prs.length);

    // const detailedStats = JSON.parse(fs.readFileSync('results.json', 'utf8'));
    const detailedStats = getDetailedStats(prs, dateFrom, dateTo);
    console.table(detailedStats);

    const stats = getSummary(detailedStats);
    console.table(stats);

    if (filename) {
        console.log('Saving results to file...');
        try {
            fs.writeFileSync(filename, JSON.stringify(detailedStats, null, 2));
        } catch (err) {
            console.error(err);
        }
    }
    // console.log(prs);
    // console.log(JSON.stringify(prs, null, 2));
}

const dateFrom = new Date('2023-09-15T00:00:00Z');
// dateFrom.setHours(0, 0, 0, 0);
// dateFrom.setDate(dateFrom.getDate() - 7);

const dateTo = new Date('2023-09-23T00:00:00Z');
// dateFrom.setHours(0, 0, 0, 0);
// dateFrom.setDate(dateFrom.getDate() + 1);

const repos = [
    { owner: '1inch', repo: 'limit-order-protocol' },
    { owner: '1inch', repo: 'limit-order-settlement' },
    { owner: '1inch', repo: 'token-plugins' },
    { owner: '1inch', repo: '1inch-contract' },
    { owner: '1inch', repo: 'st1inch' },
    { owner: '1inch', repo: 'spot-price-aggregator' },
    { owner: '1inch', repo: 'evm-helpers' },
    { owner: '1inch', repo: 'fusion-resolver' },
    { owner: '1inch', repo: 'erc20-pods' },
    { owner: '1inch', repo: 'farming' },
    { owner: '1inch', repo: 'delegating' },
    { owner: '1inch', repo: 'solidity-utils' },
    { owner: '1inch', repo: 'calldata-compressor' },
    { owner: '1inch', repo: 'merkle-distribution' },
    { owner: '1inch', repo: 'crosschain-swap' },
    { owner: '1inch', repo: 'money-market-protocol' },
    { owner: '1inch', repo: 'fee-collector' },
    { owner: '1inch', repo: 'address-token' },
    { owner: '1inch', repo: 'address-token-miner' },
    { owner: '1inch', repo: 'ERADICATE3' },
    { owner: '1inch', repo: 'solidity-audit-checklist' },
    { owner: '1inch', repo: 'minimal-erc20-wrapper' },
    { owner: '1inch', repo: 'public-pmm' }
];

main(repos, dateFrom, dateTo).then(() => { console.log('Done'); });
