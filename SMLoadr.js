const Promise = require('bluebird');
const chalk = require('chalk');
const ora = require('ora');
const sanitize = require('sanitize-filename');
const cacheManager = require('cache-manager');
require('./node_modules/cache-manager/lib/stores/memory');
const requestPlus = require('request-plus');
const flacMetadata = require('./libs/flac-metadata');
const inquirer = require('inquirer');
const fs = require('fs');
const stream = require('stream');
const nodePath = require('path');
const memoryStats = require('./libs/node-memory-stats');
const commandLineArgs = require('command-line-args');
const commandLineUsage = require('command-line-usage');
const openUrl = require('openurl');
const packageJson = require('./package.json');
const winston = require('winston');

const configFile = 'SMLoadrConfig.json';
const ConfigService = require('./src/service/ConfigService');
let configService = new ConfigService(configFile);

const EncryptionService = require('./src/service/EncryptionService');
let encryptionService = new EncryptionService();

let DOWNLOAD_DIR = 'DOWNLOADS/';
let PLAYLIST_DIR = 'PLAYLISTS/';
let PLAYLIST_FILE_ITEMS = {};

let DOWNLOAD_LINKS_FILE = 'downloadLinks.txt';
let DOWNLOAD_MODE = 'single';

const musicQualities = {
    MP3_128: {
        id: 1,
        name: 'MP3 - 128 kbps',
        aproxMaxSizeMb: '100'
    },
    MP3_320: {
        id: 3,
        name: 'MP3 - 320 kbps',
        aproxMaxSizeMb: '200'
    },
    FLAC: {
        id: 9,
        name: 'FLAC - 1411 kbps',
        aproxMaxSizeMb: '700'
    },
    MP3_MISC: {
        id: 0,
        name: 'User uploaded song'
    }
};

let selectedMusicQuality = musicQualities.MP3_320;

const cliOptionDefinitions = [
    {
        name: 'help',
        alias: 'h',
        description: 'Print this usage guide :)'
    },
    {
        name: 'quality',
        alias: 'q',
        type: String,
        defaultValue: 'MP3_320',
        description: 'The quality of the files to download: MP3_128/MP3_320/FLAC'
    },
    {
        name:         'path',
        alias:        'p',
        type:         String,
        defaultValue: DOWNLOAD_DIR,
        description:  'The path to download the files to: path with / in the end'
    },
    {
        name: 'url',
        alias: 'u',
        type: String,
        defaultOption: true,
        description: 'Downloads single deezer url: album/artist/playlist/profile/track url'
    },
    {
        name: 'downloadmode',
        alias: 'd',
        type: String,
        defaultValue: 'single',
        description: 'Downloads multiple urls from list: "all" for downloadLinks.txt'
    }
];

let cliOptions;
const isCli = process.argv.length > 2;

const downloadSpinner = new ora({
    spinner: {
        interval: 400,
        frames: [
            '♫',
            ' '
        ]
    },
    color: 'white'
});

const unofficialApiUrl = 'https://www.deezer.com/ajax/gw-light.php';
const ajaxActionUrl = 'https://www.deezer.com/ajax/action.php';

let unofficialApiQueries = {
    api_version: '1.0',
    api_token: '',
    input: 3
};

let httpHeaders;
let requestWithoutCache;
let requestWithoutCacheAndRetry;
let requestWithCache;

function initRequest() {
    httpHeaders = {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.88 Safari/537.36',
        'cache-control': 'max-age=0',
        'accept-language': 'en-US,en;q=0.9,en-US;q=0.8,en;q=0.7',
        'accept-charset': 'utf-8,ISO-8859-1;q=0.8,*;q=0.7',
        'content-type': 'text/plain;charset=UTF-8',
        'cookie': 'arl=4db7f3d6fb19d059c4eb76ab0f27073e995e15d8993c3e15a2cbb1f676b665f4a9e40d4f1d1b0fd620614035e1ee238e2bba596119ee5c8cc01c6b40fb6349a8aee1cfb66a5f5c0c59ac15d89067d3e0366505478575b0dd8dae9df9a47c3deb' 
    };

    let requestConfig = {
        retry: {
            attempts: 9999999999,
            delay: 1000, // 1 second
            errorFilter: error => 403 !== error.statusCode // retry all errors
        },
        defaults: {
            headers: httpHeaders,
        }
    };

    requestWithoutCache = requestPlus(requestConfig);


    let requestConfigWithoutCacheAndRetry = {
        defaults: {
            headers: httpHeaders
        }
    };

    requestWithoutCacheAndRetry = requestPlus(requestConfigWithoutCacheAndRetry);

    const cacheManagerCache = cacheManager.caching({
        store: 'memory',
        max: 1000
    });

    requestConfig.cache = {
        cache: cacheManagerCache,
        cacheOptions: {
            ttl: 3600 * 2 // 2 hours
        }
    };

    requestWithCache = requestPlus(requestConfig);
}

/**
 * Application init.
 */
(function initApp() {
    process.on('unhandledRejection', (reason, p) => {
        console.error('\n' + reason + '\nUnhandled Rejection at Promise' + JSON.stringify(p) + '\n');
    });

    process.on('uncaughtException', (err) => {
        console.error('\n' + err + '\nUncaught Exception thrown' + '\n');
        process.exit(1);
    });

    // App info
    console.log(chalk.cyan('╔══════════════════════════════════════════════════════════════════╗'));
    console.log(chalk.cyan('║') + chalk.bold.yellow('                          SMLoadr v' + packageJson.version + '                         ') + chalk.cyan('║'));
    console.log(chalk.cyan('╠══════════════════════════════════════════════════════════════════╣'));
    console.log(chalk.cyan('║') + ' GIT:      https://git.fuwafuwa.moe/SMLoadrDev/SMLoadr            ' + chalk.cyan('║'));
    console.log(chalk.cyan('╚══════════════════════════════════════════════════════════════════╝'));


    if (!fs.existsSync(DOWNLOAD_LINKS_FILE)) {
        ensureDir(DOWNLOAD_LINKS_FILE);
        fs.writeFileSync(DOWNLOAD_LINKS_FILE, '');
    }

	nodePath.normalize(DOWNLOAD_DIR).replace(/\/$|\\$/, '');
    nodePath.normalize(PLAYLIST_DIR).replace(/\/$|\\$/, '');

    if (isCli) {
        try {
            cliOptions = commandLineArgs(cliOptionDefinitions);
        } catch (err) {
            downloadSpinner.fail(err.message);
            process.exit(1);
        }
    }

    startApp();
})();

/**
 * Start the app.
 */
function startApp() {
    initRequest();

        downloadSpinner.text = 'Initiating Deezer API...';
        downloadSpinner.start();

        initDeezerApi().then(() => {
            downloadSpinner.succeed('Connected to Deezer API');
            selectedMusicQuality = musicQualities.MP3_320;
            askForNewDownload();
        }).catch((err) => {
            if ('Wrong Deezer credentials!' === err) {
                downloadSpinner.fail('Wrong Deezer credentials!');
                configService.set('arl', null);
                configService.saveConfig();

                startApp();
            } else {
                downloadSpinner.fail(err);
            }
        });
}

/**
 * Create directories of the given path if they don't exist.
 *
 * @param {String} filePath
 * @return {boolean}
 */
function ensureDir(filePath) {
    const dirName = nodePath.dirname(filePath);

    if (fs.existsSync(dirName)) {
        return true;
    }

    ensureDir(dirName);
    fs.mkdirSync(dirName);
}

/**
 * Fetch and set the api token.
 */
function initDeezerApi() {
    return new Promise((resolve, reject) => {

        requestWithoutCacheAndRetry({
            method: 'POST',
            url: unofficialApiUrl,
            qs: Object.assign(unofficialApiQueries, {
                method: 'deezer.getUserData',
                cid: getApiCid()
            }),
            json: true,
            jar: true
        }).then((response) => {
            if (!response || 0 < Object.keys(response.error).length) {
                throw 'Unable to initialize Deezer API.';
            } else {
                if (response.results['USER']['USER_ID'] !== 0) {
                    requestWithoutCacheAndRetry({
                        method: 'POST',
                        url: unofficialApiUrl,
                        qs: Object.assign(unofficialApiQueries, {
                            method: 'deezer.getUserData',
                            cid: getApiCid()
                        }),
                        json: true,
                        jar: true
                    }).then((response) => {
                        if (!response || 0 < Object.keys(response.error).length) {
                            throw 'Unable to initialize Deezer API.';
                        } else {
                            if (response.results && response.results.checkForm) {

                                unofficialApiQueries.api_token = response.results.checkForm;

                                resolve();
                            } else {
                                throw 'Unable to initialize Deezer API.';
                            }
                        }
                    }).catch((err) => {
                        if (404 === err.statusCode) {
                            err = 'Could not connect to Deezer.';
                        }

                        reject(err);
                    });
                } else {
                    reject('Wrong Deezer credentials!');
                }
            }
        });
    });
}
/**
 * Get a cid for a unofficial api request.
 *
 * @return {Number}
 */
function getApiCid() {
    return Math.floor(1e9 * Math.random());
}
/**
 * Remove the first line from the given file.
 *
 * @param {String} filePath
 */
function removeFirstLineFromFile(filePath) {
    const lines = fs
        .readFileSync(filePath, 'utf-8')
        .split(/^(.*)[\r|\n]/)
        .filter(Boolean);

    let contentToWrite = '';

    if (lines[1]) {
        contentToWrite = lines[1].trim();
    }

    fs.writeFileSync(filePath, contentToWrite);
}

/**
 * Ask for a album, playlist or track link to start the download.
 */
function askForNewDownload() {
    console.log('\n');

    let questions = [
        {
            type: 'input',
            name: 'deezerUrl',
            prefix: '♫',
            message: 'Deezer URL:',
            validate: (deezerUrl) => {
                if (deezerUrl) {
                    let deezerUrlType = getDeezerUrlParts(deezerUrl).type;
                    let allowedDeezerUrlTypes = [
                        'album',
                        'artist',
                        'playlist',
                        'profile',
                        'track'
                    ];

                    if (allowedDeezerUrlTypes.includes(deezerUrlType)) {
                        return true;
                    }
                }

                return 'Deezer URL example: https://www.deezer.com/album|artist|playlist|profile|track/0123456789';
            }
        }
    ];

    inquirer.prompt(questions).then(answers => {
        downloadSpinner.warn(chalk.yellow('Do not scroll while downloading! This will mess up the UI!'));

        startDownload(answers.deezerUrl).then(() => {
            askForNewDownload();
        }).catch((err) => {
            downloadSpinner.fail(err);
            downloadStateInstance.finish();
            askForNewDownload();
        });
    });
}

/**
 * Remove empty files.
 *
 * @param {Object} filePaths
 */
function removeEmptyFiles(filePaths) {
    filePaths.forEach((filePath) => {
        if (fs.existsSync(filePath)) {
            const fileContent = fs.readFileSync(filePath, 'utf-8').trim();

            if ('' === fileContent) {
                fs.unlinkSync(filePath);
            }
        }
    });
}

class downloadState {
    constructor() {
        this.currentlyDownloading = {};
        this.currentlyDownloadingPaths = [];
        this.downloading = false;
        this.numberTracksFinished = 0;
        this.numberTracksToDownload = 0;
        this.downloadType = '';
        this.downloadTypeId = 0;
        this.downloadTypeName = '';
        this.downloadedSuccessfully = null;
        this.downloadedUnsuccessfully = null;
        this.downloadedWithWarning = null;
    }

    start(downloadType, downloadTypeId) {
        this.downloading = true;
        this.downloadType = downloadType;
        this.downloadTypeId = downloadTypeId;

        this.downloadedSuccessfully = fs.createWriteStream('downloadedSuccessfully.txt', {
            flags: 'a' // 'a' means appending (old data will be preserved)
        });

        this.downloadedUnsuccessfully = fs.createWriteStream('downloadedUnsuccessfully.txt', {
            flags: 'a' // 'a' means appending (old data will be preserved)
        });

        this.downloadedWithWarning = fs.createWriteStream('downloadedWithWarning.txt', {
            flags: 'a' // 'a' means appending (old data will be preserved)
        });

        this.display();
    }

    updateNumberTracksToDownload(numberTracksToDownload) {
        this.numberTracksToDownload = numberTracksToDownload;
    }

    finish(showFinishMessage = true) {
        this.downloading = false;

        if (showFinishMessage) {
            let downloadTypeAndName = this.downloadType;

            if (this.downloadTypeName) {
                downloadTypeAndName += ' "' + this.downloadTypeName + '"';
            }

            downloadSpinner.succeed('Finished downloading ' + downloadTypeAndName);
        }

        if ('-' !== this.downloadTypeId.toString().charAt(0)) {
            this.downloadedSuccessfully.write('https://www.deezer.com/' + this.downloadType + '/' + this.downloadTypeId + '\r\n');
        }

        this.downloadedSuccessfully.end();
        this.downloadedUnsuccessfully.end();
        this.downloadedWithWarning.end();

        removeEmptyFiles([
            'downloadedSuccessfully.txt',
            'downloadedUnsuccessfully.txt',
            'downloadedWithWarning.txt'
        ]);

        this.currentlyDownloading = {};
        this.currentlyDownloadingPaths = [];
        this.numberTracksFinished = 0;
        this.numberTracksToDownload = 0;
        this.downloadType = '';
        this.downloadTypeId = 0;
        this.downloadTypeName = '';
    }

    setDownloadTypeName(downloadTypeName) {
        this.downloadTypeName = downloadTypeName;

        this.display();
    }

    add(trackId, message) {

        this.currentlyDownloading[trackId] = message;

        this.display();
    }

    update(trackId, message) {
        this.add(trackId, message);
    }

    remove(trackId) {
        delete this.currentlyDownloading[trackId];

        this.display();
    }

    success(trackId, message) {
        downloadSpinner.succeed(message);

        this.numberTracksFinished++;
        this.remove(trackId);
    }

    warn(trackId, message) {
        downloadSpinner.warn(message);

        if ('-' !== trackId.toString().charAt(0)) {
            this.downloadedWithWarning.write('https://www.deezer.com/track/' + trackId + '\r\n');
        }

        this.numberTracksFinished++;
        this.remove(trackId);
    }

    fail(trackId, message) {
        downloadSpinner.fail(message);

        if ('-' !== trackId.toString().charAt(0)) {
            this.downloadedUnsuccessfully.write('https://www.deezer.com/track/' + trackId + '\r\n');
        }

        this.numberTracksFinished++;
        this.remove(trackId);
    }

    display() {
        if (this.downloading) {
            let downloadTypeAndName = this.downloadType;

            if (this.downloadTypeName) {
                downloadTypeAndName += ' "' + this.downloadTypeName + '"';
            }

            let finishedPercentage = '0.00';

            if (0 !== this.numberTracksToDownload) {
                finishedPercentage = (this.numberTracksFinished / this.numberTracksToDownload * 100).toFixed(2);
            }

            let downloadSpinnerText = chalk.green('Downloading ' + downloadTypeAndName + ' [' + this.numberTracksFinished + '/' + this.numberTracksToDownload + ' - ' + finishedPercentage + '%]:\n');

            if (0 < Object.keys(this.currentlyDownloading).length) {
                downloadSpinnerText += '  › ' + Object.values(this.currentlyDownloading).join('\n  › ');
            } else {
                downloadSpinnerText += '  › Fetching infos...';
            }

            downloadSpinner.start(downloadSpinnerText);
        }
    }

    addCurrentlyDownloadingPath(downloadPath) {
        this.currentlyDownloadingPaths.push(downloadPath);
    }

    removeCurrentlyDownloadingPath(downloadPath) {
        const index = this.currentlyDownloadingPaths.indexOf(downloadPath);

        if (-1 !== index) {
            this.currentlyDownloadingPaths.splice(index, 1);
        }
    }

    isCurrentlyDownloadingPathUsed(downloadPath) {
        return (this.currentlyDownloadingPaths.indexOf(downloadPath) > -1);
    }
}

let downloadStateInstance = new downloadState();

/**
 * Start a deezer download.
 *
 * @param {String}  deezerUrl
 * @param {Boolean} downloadFromFile
 */
function startDownload(deezerUrl, downloadFromFile = false) {

    const deezerUrlParts = getDeezerUrlParts(deezerUrl);

    downloadStateInstance.start(deezerUrlParts.type, deezerUrlParts.id);

    switch (deezerUrlParts.type) {
        case 'album':
        case 'playlist':
        case 'profile':
            return downloadMultiple(deezerUrlParts.type, deezerUrlParts.id).then(() => {
                downloadStateInstance.finish(!downloadFromFile);
            });
        case 'artist':
            return downloadArtist(deezerUrlParts.id).then(() => {
                downloadStateInstance.finish(!downloadFromFile);
            });
        case 'track':
            downloadStateInstance.updateNumberTracksToDownload(1);

            return downloadSingleTrack(deezerUrlParts.id).then(() => {
                downloadStateInstance.finish(!downloadFromFile);
            });
    }
}

/**
 * Get the url type (album/artist/playlist/profile/track) and the id from the deezer url.
 *
 * @param {String} deezerUrl
 *
 * @return {Object}
 */
function getDeezerUrlParts(deezerUrl) {
    const urlParts = deezerUrl.split(/\/(\w+)\/(\d+)/);

    return {
        type: urlParts[1],
        id: urlParts[2]
    };
}

/**
 * Download all tracks of an artists.
 *
 * @param {Number} id
 */
function downloadArtist(id) {
    return new Promise((resolve, reject) => {
        let requestParams = {
            method: 'POST',
            url: unofficialApiUrl,
            qs: Object.assign(unofficialApiQueries, {
                method: 'artist.getData',
                cid: getApiCid()
            }),
            body: {
                art_id: id,
                filter_role_id: [0],
                lang: 'us',
                tab: 0,
                nb: -1,
                start: 0
            },
            json: true,
            jar: true
        };

        requestWithCache(requestParams).then((response) => {
            if (!response || 0 < Object.keys(response.error).length) {
                if (response.error.VALID_TOKEN_REQUIRED) {
                    initDeezerApi();

                    setTimeout(() => {
                        downloadArtist(id).then(() => {
                            resolve();
                        }).catch((err) => {
                            reject(err);
                        });
                    }, 1000);
                } else {
                    throw 'Could not fetch the artist!';
                }
            } else {

                const artistName = response.results.ART_NAME;
                downloadStateInstance.setDownloadTypeName(artistName);

                requestParams.qs.method = 'album.getDiscography';
                requestParams.qs.cid = getApiCid();
                requestParams.body = {
                    art_id: id,
                    filter_role_id: [0],
                    lang: 'us',
                    nb: 500,
                    nb_songs: -1,
                    start: 0
                };

                requestWithoutCache(requestParams).then((response) => {
                    if (!response || 0 < Object.keys(response.error).length) {
                        if (response.error.VALID_TOKEN_REQUIRED) {
                            initDeezerApi();

                            setTimeout(() => {
                                downloadArtist(id).then(() => {
                                    resolve();
                                }).catch((err) => {
                                    reject(err);
                                });
                            }, 1000);
                        } else {
                            throw 'Could not fetch "' + artistName + '" albums!';
                        }
                    } else {

                        if (0 < response.results.data.length) {
                            let trackList = [];
                            let albumList = {};

                            response.results.data.forEach((album) => {
                                albumList[album.ALB_ID] = album;

                                album.SONGS.data.forEach((track) => {
                                    trackList.push(track);
                                });
                            });

                            downloadStateInstance.updateNumberTracksToDownload(trackList.length);

                            trackListDownload(trackList, albumList).then(() => {
                                resolve();
                            });
                        } else {
                            downloadSpinner.warn('No tracks to download for artist "' + artistName + '"');

                            resolve();
                        }
                    }
                }).catch((err) => {
                    reject(err);
                });
            }
        }).catch((err) => {
            reject(err);
        });
    });
}

/**
 * Download multiple tracks (album, playlist or users favourite tracks)
 *
 * @param {String} type
 * @param {Number} id
 */
function downloadMultiple(type, id) {
    let requestBody;
    let requestQueries = unofficialApiQueries;

    switch (type) {
        case 'album':
            requestQueries.method = 'deezer.pageAlbum';
            requestBody = {
                alb_id: id,
                lang: 'en',
                tab: 0
            };
            break;

        case 'playlist':
            requestQueries.method = 'deezer.pagePlaylist';
            requestBody = {
                playlist_id: id,
                lang: 'en',
                nb: -1,
                start: 0,
                tab: 0,
                tags: true,
                header: true
            };
            break;

        case 'profile':
            requestQueries.method = 'deezer.pageProfile';
            requestBody = {
                user_id: id,
                tab: 'loved',
                nb: -1
            };
            break;
    }

    let requestParams = {
        method: 'POST',
        url: unofficialApiUrl,
        qs: requestQueries,
        body: requestBody,
        json: true,
        jar: true
    };

    let request = requestWithoutCache;

    if (!['playlist', 'profile'].includes(type)) {
        request = requestWithCache;
    }

    return new Promise((resolve, reject) => {
        request(requestParams).then((response) => {
            if (!response || 0 < Object.keys(response.error).length || ('playlist' === type && 1 === Number(response.results.DATA.STATUS) && 0 < response.results.DATA.DURATION && 0 === response.results.SONGS.data.length)) {
                if (response.error.VALID_TOKEN_REQUIRED) {
                    initDeezerApi();

                    setTimeout(() => {
                        downloadMultiple(type, id).then(() => {
                            resolve();
                        }).catch((err) => {
                            reject(err);
                        });
                    }, 1000);
                } else if ('playlist' === type && response.results && response.results.DATA && 1 === Number(response.results.DATA.STATUS && 0 < response.results.DATA.DURATION && 0 === response.results.SONGS.data.length)) {
                    throw 'Other users private playlists are not supported!';
                } else {
                    throw 'Could not fetch the ' + type + '!';
                }
            } else {

                let trackList = [];
                let albumList = {};
                let downloadTypeName = '';

                switch (type) {
                    case 'album':
                        trackList = response.results.SONGS.data;

                        response.results.DATA.SONGS = response.results.SONGS;
                        albumList[response.results.DATA.ALB_ID] = response.results.DATA;

                        downloadTypeName = response.results.DATA.ALB_TITLE;

                        break;
                    case 'playlist':
                        trackList = response.results.SONGS.data;
                        downloadTypeName = response.results.DATA.TITLE;

                        break;
                    case 'profile':
                        trackList = response.results.TAB.loved.data;
                        downloadTypeName = response.results.DATA.USER.DISPLAY_NAME;

                        break;
                }

                downloadStateInstance.setDownloadTypeName(downloadTypeName);

                if (0 < trackList.length) {
                    // We don't want to generate a playlist file if this is no playlist
                    if (['profile', 'album'].includes(type)) {
                        PLAYLIST_FILE_ITEMS = null;
                    } else {
                        PLAYLIST_FILE_ITEMS = {};
                    }

                    downloadStateInstance.updateNumberTracksToDownload(trackList.length);

                    trackListDownload(trackList, albumList).then(() => {
                        // Generate the playlist file
                        if (PLAYLIST_FILE_ITEMS != null) {
                            const playlistName = multipleWhitespacesToSingle(sanitizeFilename(response.results.DATA.TITLE));
                            const playlistFile = nodePath.join(PLAYLIST_DIR, playlistName + '.m3u8');
                            let playlistFileContent = '';

                            for (let i = 0; i < PLAYLIST_FILE_ITEMS.length; i++) {
                                playlistFileContent += PLAYLIST_FILE_ITEMS[i] + '\r\n';
                            }

                            trackList.forEach((trackInfos) => {
                                if (PLAYLIST_FILE_ITEMS[trackInfos.SNG_ID]) {
                                    const playlistFileItem = PLAYLIST_FILE_ITEMS[trackInfos.SNG_ID];

                                    playlistFileContent += '#EXTINF:' + playlistFileItem.trackDuration + ',' + playlistFileItem.trackArtist + ' - ' + playlistFileItem.trackTitle + '\r\n';
                                    playlistFileContent += '../' + playlistFileItem.trackSavePath + '\r\n';
                                }
                            });

                            ensureDir(playlistFile);
                            fs.writeFileSync(playlistFile, playlistFileContent);
                        }

                        resolve();
                    });
                } else {
                    downloadSpinner.warn('No tracks to download for ' + type + ' "' + downloadTypeName + '"');

                    resolve();
                }
            }
        }).catch((err) => {
            reject(err);
        });
    });
}

/**
 * Get the number of parallel downloads to use for the current available memory and selected quality.
 *
 * @return {Number}
 */
function getNumberOfParallelDownloads() {
    let freeMemoryMb;
    const approxMaxSizeMb = selectedMusicQuality.aproxMaxSizeMb;

    try {
        freeMemoryMb = memoryStats.free() / 1024 / 1024;
    } catch (e) {
        freeMemoryMb = 0;
    }

    let numberOfParallel = parseInt(((freeMemoryMb - 300) / approxMaxSizeMb).toString());

    if (20 < numberOfParallel) {
        numberOfParallel = 20;
    } else if (1 > numberOfParallel) {
        numberOfParallel = 1;
    }

    return numberOfParallel;
}

/**
 * Map through a track list and download it.
 *
 * @param {Object} trackList
 * @param {Object} albumInfos
 */
function trackListDownload(trackList, albumInfos = {}) {
    const numberOfParallel = getNumberOfParallelDownloads();

    return Promise.map(trackList, (trackInfos) => {
        let trackAlbumInfos;

        if (albumInfos[trackInfos.ALB_ID]) {
            trackAlbumInfos = albumInfos[trackInfos.ALB_ID];
        }

        trackInfos.SNG_TITLE_VERSION = trackInfos.SNG_TITLE;

        if (trackInfos.VERSION) {
            trackInfos.SNG_TITLE_VERSION = (trackInfos.SNG_TITLE + ' ' + trackInfos.VERSION).trim();
        }

        let artistName = trackInfos.ART_NAME;

        if (trackAlbumInfos && '' !== trackAlbumInfos.ART_NAME) {
            artistName = trackAlbumInfos.ART_NAME;
        }

        artistName = multipleWhitespacesToSingle(sanitizeFilename(artistName));

        if ('' === artistName.trim()) {
            artistName = 'Unknown artist';
        }

        if ('various' === artistName.trim().toLowerCase()) {
            artistName = 'Various Artists';
        }

        let albumName = multipleWhitespacesToSingle(sanitizeFilename(trackInfos.ALB_TITLE));

        if ('' === albumName.trim()) {
            albumName = 'Unknown album';
        }

        albumName += ' (Album)';

        let saveFileDir = nodePath.join(DOWNLOAD_DIR, artistName, albumName);

        if (trackAlbumInfos && trackAlbumInfos.SONGS && trackAlbumInfos.SONGS.data && 0 < trackAlbumInfos.SONGS.data.length && '' !== trackAlbumInfos.SONGS.data[trackAlbumInfos.SONGS.data.length - 1].DISK_NUMBER) {
            const albumNumberOfDisks = trackAlbumInfos.SONGS.data[trackAlbumInfos.SONGS.data.length - 1].DISK_NUMBER;

            if (albumNumberOfDisks > 1) {
                saveFileDir += nodePath.join(saveFileDir, 'Disc ' + toTwoDigits(trackInfos.DISK_NUMBER));
            }
        }

        let saveFileName = multipleWhitespacesToSingle(sanitizeFilename(toTwoDigits(trackInfos.TRACK_NUMBER) + ' ' + trackInfos.SNG_TITLE_VERSION));
        let fileExtension = 'mp3';

        if (musicQualities.FLAC.id === selectedMusicQuality.id) {
            fileExtension = 'flac';
        }

        const downloadingMessage = artistName + ' - ' + trackInfos.SNG_TITLE_VERSION;
        downloadStateInstance.add(trackInfos.SNG_ID, downloadingMessage);

        return downloadSingleTrack(trackInfos.SNG_ID, trackInfos, trackAlbumInfos);
    }, {
        concurrency: numberOfParallel
    });
}

/**
 * Download a track + id3tags (album cover...) and save it in the downloads folder.
 *
 * @param {Number}  id
 * @param {Object}  trackInfos
 * @param {Object}  albumInfos
 * @param {Boolean} isAlternativeTrack
 * @param {Number}  numberRetry
 */
function downloadSingleTrack(id, trackInfos = {}, albumInfos = {}, isAlternativeTrack = false, numberRetry = 0) {
    let dirPath;
    let saveFilePath;
    let originalTrackInfos;
    let fileExtension = 'mp3';
    let trackQuality;

    return new Promise((resolve) => {
        if ('-' === id.toString().charAt(0) && 0 < Object.keys(trackInfos).length) {
            getTrackAlternative(trackInfos).then((alternativeTrackInfos) => {
                downloadStateInstance.remove(id);

                downloadSingleTrack(alternativeTrackInfos.SNG_ID, {}, {}, true).then(() => {
                    resolve();
                });
            }).catch(() => {
                startTrackInfoFetching();
            });
        } else {
            startTrackInfoFetching();
        }

        function startTrackInfoFetching() {
            if (!isAlternativeTrack && 0 < Object.keys(trackInfos).length) {
                originalTrackInfos = trackInfos;

                afterTrackInfoFetching();
            } else {
                getTrackInfos(id).then((trackInfosResponse) => {
                    originalTrackInfos = trackInfosResponse;

                    afterTrackInfoFetching();
                }).catch((err) => {
                    errorHandling(err);
                });
            }
        }

        function afterTrackInfoFetching() {
            if (!isAlternativeTrack || 0 === Object.keys(trackInfos).length) {
                trackInfos = originalTrackInfos;
            }

            trackQuality = musicQualities.MP3_320;

            originalTrackInfos.SNG_TITLE_VERSION = originalTrackInfos.SNG_TITLE;

            if (originalTrackInfos.VERSION) {
                originalTrackInfos.SNG_TITLE_VERSION = (originalTrackInfos.SNG_TITLE + ' ' + originalTrackInfos.VERSION).trim();
            }

            if (0 < Object.keys(albumInfos).length || 0 === trackInfos.ALB_ID) {
                afterAlbumInfoFetching();
            } else {
                const downloadingMessage = trackInfos.ART_NAME + ' - ' + trackInfos.SNG_TITLE_VERSION;
                downloadStateInstance.update(originalTrackInfos.SNG_ID, downloadingMessage);

                getAlbumInfos(trackInfos.ALB_ID).then((albumInfosResponse) => {
                    albumInfos = albumInfosResponse;

                    albumInfos.TYPE = 'album';
                    albumInfos.GENRES = [];

                    afterAlbumInfoFetching();
                }).catch(() => {
                    afterAlbumInfoFetching();
                });
            }
        }

        function afterAlbumInfoFetching() {
            originalTrackInfos.ALB_UPC = '';
            originalTrackInfos.ALB_LABEL = '';
            originalTrackInfos.ALB_NUM_TRACKS = '';
            originalTrackInfos.ALB_NUM_DISCS = '';

            if (albumInfos.UPC) {
                originalTrackInfos.ALB_UPC = albumInfos.UPC;
            }

            if (albumInfos.PHYSICAL_RELEASE_DATE && !trackInfos.ALB_RELEASE_DATE) {
                originalTrackInfos.ALB_RELEASE_DATE = albumInfos.PHYSICAL_RELEASE_DATE;
            }

            if (albumInfos.SONGS && 0 < albumInfos.SONGS.data.length && albumInfos.SONGS.data[albumInfos.SONGS.data.length - 1].DISK_NUMBER) {
                originalTrackInfos.ALB_NUM_DISCS = albumInfos.SONGS.data[albumInfos.SONGS.data.length - 1].DISK_NUMBER;
            }

            originalTrackInfos.ALB_ART_NAME = originalTrackInfos.ART_NAME;

            if (albumInfos.ART_NAME) {
                originalTrackInfos.ALB_ART_NAME = albumInfos.ART_NAME;
            }

            if (!originalTrackInfos.ARTISTS || 0 === originalTrackInfos.ARTISTS.length) {
                originalTrackInfos.ARTISTS = [
                    {
                        ART_ID: originalTrackInfos.ART_ID,
                        ART_NAME: originalTrackInfos.ALB_ART_NAME,
                        ART_PICTURE: originalTrackInfos.ART_PICTURE
                    }
                ];
            }

            if ('various' === originalTrackInfos.ALB_ART_NAME.trim().toLowerCase()) {
                originalTrackInfos.ALB_ART_NAME = 'Various Artists';
            }

            if (albumInfos.LABEL_NAME) {
                originalTrackInfos.ALB_LABEL = albumInfos.LABEL_NAME;
            }

            if (albumInfos.SONGS && albumInfos.SONGS.data.length) {
                originalTrackInfos.ALB_NUM_TRACKS = albumInfos.SONGS.data.length;
            }

            const downloadingMessage = trackInfos.ALB_ART_NAME + ' - ' + trackInfos.SNG_TITLE_VERSION;
            downloadStateInstance.update(originalTrackInfos.SNG_ID, downloadingMessage);

            if (0 === trackInfos.ALB_ID) {
                afterAlbumInfoOfficialApiFetching();
            } else {
                getAlbumInfosOfficialApi(trackInfos.ALB_ID).then((albumInfosResponse) => {
                    albumInfos.TYPE = albumInfosResponse.record_type;
                    albumInfos.GENRES = [];

                    albumInfosResponse.genres.data.forEach((albumGenre) => {
                        albumInfos.GENRES.push(albumGenre.name);
                    });

                    afterAlbumInfoOfficialApiFetching();
                }).catch(() => {
                    afterAlbumInfoOfficialApiFetching();
                });
            }
        }

        function afterAlbumInfoOfficialApiFetching() {
            originalTrackInfos.ALB_GENRES = albumInfos.GENRES;

            if (albumInfos.TYPE) {
                originalTrackInfos.ALB_RELEASE_TYPE = albumInfos.TYPE;
            }

            if (isAlternativeTrack) {
                trackInfos.DURATION = originalTrackInfos.DURATION;
                trackInfos.GAIN = originalTrackInfos.GAIN;
                trackInfos.LYRICS_ID = originalTrackInfos.LYRICS_ID;
                trackInfos.LYRICS = originalTrackInfos.LYRICS;
            } else {
                trackInfos = originalTrackInfos;
            }

            if (trackQuality) {
                let artistName = multipleWhitespacesToSingle(sanitizeFilename(trackInfos.ALB_ART_NAME));

                if ('' === artistName.trim()) {
                    artistName = 'Unknown artist';
                }

                let albumType = 'Album';

                if (albumInfos.TYPE) {
                    albumType = albumInfos.TYPE.toLowerCase();

                    if ('ep' === albumType) {
                        albumType = 'EP';
                    } else {
                        albumType = capitalizeFirstLetter(albumType);
                    }
                }

                let albumName = multipleWhitespacesToSingle(sanitizeFilename(trackInfos.ALB_TITLE));

                if ('' === albumName.trim()) {
                    albumName = 'Unknown album';
                }

                albumName += ' (' + albumType + ')';

                if (trackInfos.ALB_NUM_DISCS > 1) {
                    dirPath = nodePath.join(DOWNLOAD_DIR, artistName, albumName, 'Disc ' + toTwoDigits(trackInfos.DISK_NUMBER));
                } else {
                    dirPath = nodePath.join(DOWNLOAD_DIR, artistName, albumName);
                }

                if (musicQualities.FLAC.id === trackQuality.id) {
                    fileExtension = 'flac';
                }
                saveFilePath = dirPath + nodePath.sep;

                if (trackInfos.TRACK_NUMBER) {
                    saveFilePath += toTwoDigits(trackInfos.TRACK_NUMBER) + ' ';
                }

                saveFilePath += multipleWhitespacesToSingle(sanitizeFilename(trackInfos.SNG_TITLE_VERSION));

                saveFilePath += '.' + fileExtension;

                if (!fs.existsSync(saveFilePath) && !downloadStateInstance.isCurrentlyDownloadingPathUsed(saveFilePath)) {
                    downloadStateInstance.addCurrentlyDownloadingPath(saveFilePath);

                    return downloadTrack(originalTrackInfos, trackQuality.id, saveFilePath).then((decryptedTrackBuffer) => {
                        onTrackDownloadComplete(decryptedTrackBuffer);
                    }).catch((error) => {

                        if (originalTrackInfos.FALLBACK && originalTrackInfos.FALLBACK.SNG_ID && trackInfos.SNG_ID !== originalTrackInfos.FALLBACK.SNG_ID && originalTrackInfos.SNG_ID !== originalTrackInfos.FALLBACK.SNG_ID) {
                            downloadStateInstance.removeCurrentlyDownloadingPath(saveFilePath);
                            downloadStateInstance.remove(originalTrackInfos.SNG_ID);

                            downloadSingleTrack(originalTrackInfos.FALLBACK.SNG_ID, trackInfos, albumInfos, true).then(() => {
                                resolve();
                            });

                            const error = {
                                message: '-',
                                name:    'notAvailableButAlternative'
                            };

                            errorHandling(error);
                        } else {
                            getTrackAlternative(trackInfos).then((alternativeTrackInfos) => {
                                downloadStateInstance.removeCurrentlyDownloadingPath(saveFilePath);
                                downloadStateInstance.remove(originalTrackInfos.SNG_ID);

                                if (albumInfos.ALB_TITLE) {
                                    albumInfos = {};
                                }

                                downloadSingleTrack(alternativeTrackInfos.SNG_ID, trackInfos, albumInfos, true).then(() => {
                                    resolve();
                                });
                            }).catch(() => {
                                const errorMessage = trackInfos.ALB_ART_NAME + ' - ' + trackInfos.SNG_TITLE_VERSION + '\n  › Deezer doesn\'t provide the song anymore';

                                errorHandling(errorMessage);
                            });
                        }
                    });
                } else {

                    const error = {
                        message: trackInfos.ALB_ART_NAME + ' - ' + trackInfos.SNG_TITLE_VERSION + ' \n  › Song already exists',
                        name:    'songAlreadyExists'
                    };

                    errorHandling(error);
                }
            } else {
                errorHandling(trackInfos.ALB_ART_NAME + ' - ' + trackInfos.SNG_TITLE_VERSION + '\n  › Deezer doesn\'t provide the song anymore');
            }
        }

        function onTrackDownloadComplete(decryptedTrackBuffer) {
            let downloadMessageAppend = '';

            if (isAlternativeTrack && originalTrackInfos.SNG_TITLE_VERSION.trim().toLowerCase() !== trackInfos.SNG_TITLE_VERSION.trim().toLowerCase()) {
                downloadMessageAppend = '\n  › Used "' + originalTrackInfos.ALB_ART_NAME + ' - ' + originalTrackInfos.SNG_TITLE_VERSION + '" as alternative';
            }

            if (trackQuality !== selectedMusicQuality) {
                let selectedMusicQualityName = musicQualities[Object.keys(musicQualities).find(key => musicQualities[key] === selectedMusicQuality)].name;
                let trackQualityName = musicQualities[Object.keys(musicQualities).find(key => musicQualities[key] === trackQuality)].name;

                downloadMessageAppend += '\n  › Used "' + trackQualityName + '" because "' + selectedMusicQualityName + '" wasn\'t available';
            }

            const successMessage = '' + trackInfos.ALB_ART_NAME + ' - ' + trackInfos.SNG_TITLE_VERSION + '' + downloadMessageAppend;

            addTrackTags(decryptedTrackBuffer, trackInfos, saveFilePath).then(() => {
                downloadStateInstance.success(originalTrackInfos.SNG_ID, successMessage);

                downloadStateInstance.removeCurrentlyDownloadingPath(saveFilePath);

                resolve();
            }).catch(() => {
                const warningMessage = successMessage + '\n  › Failed writing ID3 tags';
                downloadStateInstance.warn(originalTrackInfos.SNG_ID, warningMessage);

                downloadStateInstance.removeCurrentlyDownloadingPath(saveFilePath);
                resolve();
            });
        }

        function errorHandling(err) {
            if (404 === err.statusCode) {
                err = 'Track "' + id + '" not found';
            }

            if (err.name && err.message) {
                if ('-' !== err.message) {
                    if ('songAlreadyExists' === err.name) {
                        downloadStateInstance.success(originalTrackInfos.SNG_ID, err.message);
                    } else {
                        downloadStateInstance.fail(originalTrackInfos.SNG_ID, err.message);
                    }
                }
            } else {
                downloadStateInstance.fail(id, err);
            }

            if ('notAvailableButAlternative' !== err.name && 'invalidApiToken' !== err.name) {
                resolve();
            }
        }
    });
}

/**
 * Get track infos of a song by id.
 *
 * @param {Number} id
 */
function getTrackInfos(id) {
    return new Promise((resolve, reject) => {
        return requestWithCache({
            method: 'POST',
            url: unofficialApiUrl,
            qs: Object.assign(unofficialApiQueries, {
                method: 'deezer.pageTrack',
                cid: getApiCid()
            }),
            body: {
                sng_id: id
            },
            json: true,
            jar: true
        }).then((response) => {

            if (response && 0 === Object.keys(response.error).length && response.results && response.results.DATA) {
                let trackInfos = response.results.DATA;

                if (response.results.LYRICS) {
                    trackInfos.LYRICS = response.results.LYRICS;
                }

                resolve(trackInfos);
            } else if (response.error.VALID_TOKEN_REQUIRED) {
                initDeezerApi();

                setTimeout(() => {
                    getTrackInfos(id).then((trackInfos) => {
                        resolve(trackInfos);
                    }).catch((err) => {
                        reject(err);
                    });
                }, 1000);
            } else {
                reject({statusCode: 404});
            }
        }).catch(() => {
            reject({statusCode: 404});
        });
    });
}

/**
 * Get alternative track for a song by its track infos.
 *
 * @param {Object} trackInfos
 */
function getTrackAlternative(trackInfos) {
    return new Promise((resolve, reject) => {
        return requestWithCache({
            method: 'POST',
            url: unofficialApiUrl,
            qs: Object.assign(unofficialApiQueries, {
                method: 'search.music',
                cid: getApiCid()
            }),
            body: {
                QUERY: 'artist:\'' + trackInfos.ART_NAME + '\' track:\'' + trackInfos.SNG_TITLE + '\'',
                OUTPUT: 'TRACK',
                NB: 50,
                FILTER: 0
            },
            json: true,
            jar: true
        }).then((response) => {

            if (response && 0 === Object.keys(response.error).length && response.results && response.results.data && 0 > response.results.data.length) {
                const foundTracks = response.results.data;
                let matchingTracks = [];
                if (foundTracks.length > 0) {
                    foundTracks.forEach((foundTrack) => {
                        if (trackInfos.MD5_ORIGIN === foundTrack.MD5_ORIGIN && trackInfos.DURATION - 5 <= foundTrack.DURATION && trackInfos.DURATION + 10 >= foundTrack.DURATION) {
                            matchingTracks.push(foundTrack);
                        }
                    });

                    if (1 === matchingTracks.length) {
                        resolve(matchingTracks[0]);
                    } else {
                        let foundAlternativeTrack = false;

                        if (0 === matchingTracks.length) {
                            foundTracks.forEach((foundTrack) => {
                                if (trackInfos.MD5_ORIGIN === foundTrack.MD5_ORIGIN) {
                                    matchingTracks.push(foundTrack);
                                }
                            });
                        }

                        matchingTracks.forEach((foundTrack) => {
                            foundTrack.SNG_TITLE_VERSION = foundTrack.SNG_TITLE;

                            if (foundTrack.VERSION) {
                                foundTrack.SNG_TITLE_VERSION = (foundTrack.SNG_TITLE + ' ' + foundTrack.VERSION).trim();
                            }

                            if (removeWhitespacesAndSpecialChars(trackInfos.SNG_TITLE_VERSION).toLowerCase() === removeWhitespacesAndSpecialChars(foundTrack.SNG_TITLE_VERSION).toLowerCase()) {
                                foundAlternativeTrack = true;

                                resolve(foundTrack);
                            }
                        });

                        if (!foundAlternativeTrack) {
                            reject();
                        }
                    }
                } else {
                    reject();
                }
            } else if (response.error.VALID_TOKEN_REQUIRED) {
                initDeezerApi();

                setTimeout(() => {
                    getTrackAlternative(trackInfos).then((alternativeTrackInfos) => {
                        resolve(alternativeTrackInfos);
                    }).catch(() => {
                        reject();
                    });
                }, 1000);
            } else {
                reject();
            }
        }).catch(() => {
            reject();
        });
    });
}

/**
 * Remove whitespaces and special characters from the given string.
 *
 * @param {String} string
 */
function removeWhitespacesAndSpecialChars(string) {
    return string.replace(/[^A-Z0-9]/ig, '');
}

/**
 * Get infos of an album by id.
 *
 * @param {Number} id
 */
function getAlbumInfos(id) {
    return new Promise((resolve, reject) => {
        return requestWithCache({
            method: 'POST',
            url: unofficialApiUrl,
            qs: Object.assign(unofficialApiQueries, {
                method: 'deezer.pageAlbum',
                cid: getApiCid()
            }),
            body: {
                alb_id: id,
                lang: 'us',
                tab: 0
            },
            json: true,
            jar: true
        }).then((response) => {

            if (response && 0 === Object.keys(response.error).length && response.results && response.results.DATA && response.results.SONGS) {
                let albumInfos = response.results.DATA;
                albumInfos.SONGS = response.results.SONGS;

                resolve(albumInfos);
            } else if (response.error.VALID_TOKEN_REQUIRED) {
                initDeezerApi();

                setTimeout(() => {
                    getAlbumInfos(id).then((albumInfos) => {
                        resolve(albumInfos);
                    }).catch((err) => {
                        reject(err);
                    });
                }, 1000);
            } else {
                reject({statusCode: 404});
            }
        }).catch(() => {
            reject({statusCode: 404});
        });
    });
}

/**
 * Get infos of an album from the official api by id.
 *
 * @param {Number} id
 */
function getAlbumInfosOfficialApi(id) {
    return new Promise((resolve, reject) => {
        return requestWithCache({
            url: 'https://api.deezer.com/album/' + id,
            json: true
        }).then((albumInfos) => {

            if (albumInfos && !albumInfos.error) {
                resolve(albumInfos);
            } else {
                reject({statusCode: 404});
            }
        }).catch(() => {
            reject({statusCode: 404});
        });
    });
}

/**
 * Get lyrics of a track by id.
 *
 * @param {Number} id
 */
function getTrackLyrics(id) {
    return new Promise((resolve, reject) => {
        return requestWithCache({
            method: 'POST',
            url: unofficialApiUrl,
            qs: Object.assign(unofficialApiQueries, {
                method: 'song.getLyrics',
                cid: getApiCid()
            }),
            body: {
                sng_id: id
            },
            json: true,
            jar: true
        }).then((response) => {

            if (response && 0 === Object.keys(response.error).length && response.results && response.results.LYRICS_ID) {
                let trackLyrics = response.results;

                resolve(trackLyrics);
            } else if (response.error.VALID_TOKEN_REQUIRED) {
                initDeezerApi();

                setTimeout(() => {
                    getTrackLyrics(id).then((trackLyrics) => {
                        resolve(trackLyrics);
                    }).catch((err) => {
                        reject(err);
                    });
                }, 1000);
            } else {
                reject({statusCode: 404});
            }
        }).catch(() => {
            reject({statusCode: 404});
        });
    });
}

/**
 * Capitalizes the first letter of a string
 *
 * @param {String} string
 *
 * @returns {String}
 */
function capitalizeFirstLetter(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

/**
 * Adds a zero to the beginning if the number has only one digit.
 *
 * @param {Number} number
 * @returns {String}
 */
function toTwoDigits(number) {
    return (number < 10 ? '0' : '') + number;
}

/**
 * Replaces multiple whitespaces with a single one.
 *
 * @param {String} string
 * @returns {String}
 */
function multipleWhitespacesToSingle(string) {
    return string.replace(/[ _,]+/g, ' ');
}

/**
 * Replaces multiple whitespaces with a single one.
 *
 * @param {String} fileName
 * @returns {String}
 */
function sanitizeFilename(fileName) {
    fileName = fileName.replace('/', '-');

    return sanitize(fileName);
}

/**
 * Calculate the URL to download the track.
 *
 * @param {Object} trackInfos
 * @param {Number} trackQuality
 *
 * @returns {String}
 */
function getTrackDownloadUrl(trackInfos, trackQuality) {
    const cdn = trackInfos.MD5_ORIGIN[0];

    return 'https://e-cdns-proxy-' + cdn + '.dzcdn.net/mobile/1/' + encryptionService.getSongFileName(trackInfos, trackQuality);
}

/**
 * Download the track, decrypt it and write it to a file.
 *
 * @param {Object} trackInfos
 * @param {Number} trackQualityId
 * @param {String} saveFilePath
 * @param {Number} numberRetry
 */
function downloadTrack(trackInfos, trackQualityId, saveFilePath, numberRetry = 0) {
    return new Promise((resolve, reject) => {
        const trackDownloadUrl = getTrackDownloadUrl(trackInfos, trackQualityId);

        requestWithoutCache({
            url: trackDownloadUrl,
            headers: httpHeaders,
            jar: true,
            encoding: null
        }).then((response) => {

            const decryptedTrackBuffer = encryptionService.decryptTrack(response, trackInfos);

            resolve(decryptedTrackBuffer);
        }).catch((err) => {
            if (403 === err.statusCode) {
                let maxNumberRetry = 1;

                if ((trackInfos.RIGHTS && 0 !== Object.keys(trackInfos.RIGHTS).length) || (trackInfos.AVAILABLE_COUNTRIES && trackInfos.AVAILABLE_COUNTRIES.STREAM_ADS && 0 < trackInfos.AVAILABLE_COUNTRIES.STREAM_ADS.length)) {
                    maxNumberRetry = 2;
                }

                if (maxNumberRetry >= numberRetry) {
                    numberRetry += 1;

                    setTimeout(() => {
                        downloadTrack(trackInfos, trackQualityId, saveFilePath, numberRetry).then((decryptedTrackBuffer) => {
                            resolve(decryptedTrackBuffer);
                        }).catch((error) => {
                            reject(error);
                        });
                    }, 1000);
                } else {
                    reject(err);
                }
            } else {
                reject(err);
            }
        });
    });
}

/**
 * Add tags to the mp3/flac file.
 *
 * @param {Buffer} decryptedTrackBuffer
 * @param {Object} trackInfos
 * @param {String} saveFilePath
 * @param {Number} numberRetry
 */
function addTrackTags(decryptedTrackBuffer, trackInfos, saveFilePath, numberRetry = 0) {
    return new Promise((resolve, reject) => {


        ensureDir(saveFilePath);
        fs.writeFileSync(saveFilePath, decryptedTrackBuffer);

        resolve();

    });
}