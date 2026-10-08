import {test} from 'node:test';
import assert from 'node:assert/strict';
import {routeLinks} from './route-links.mjs';
test('discovers observed same-origin route pages and rejects unrelated or credential URLs',()=>{
 const base='https://www.aircanada.com/en-ca/flights-from-tel-aviv';
 const path='/en-ca/flights-from-tel-aviv-to-toronto';
 const html=[path,path,'https://evil.example'+path,path+'?token=x',path+'#x','javascript:alert(1)','https://u:p@www.aircanada.com'+path,'/en-ca/account'].map(url=>`<a href="${url}">route</a>`).join('');
 assert.deepEqual(routeLinks(html,base),['https://www.aircanada.com'+path]);
});
test('discovers only observed Frontier root route links without inventing translated paths',()=>{
 const path='/flights-from-denver-to-phoenix';
 assert.deepEqual(routeLinks(`<a href="${path}">route</a><a href="${path}?token=x">bad</a><a href="https://evil.test${path}">bad</a>`,'https://flights.flyfrontier.com/'),['https://flights.flyfrontier.com'+path]);
 assert.deepEqual(routeLinks(`<a href="${path}">route</a>`,'https://www.aircanada.com/'),[]);
});