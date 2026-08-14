import test from 'node:test';
import assert from 'node:assert/strict';
import { appendMessage, canTransition, updateMessage } from '../extension/src/shared/conversation.ts';
const message=(id,status='submitting')=>({id,role:'user',source:'manual',text:id,status,createdAt:1,updatedAt:1});
test('keeps concurrent translations associated with separate messages',()=>{let state={id:'c',messages:[],updatedAt:0};state=appendMessage(state,message('first'));state=appendMessage(state,message('second'));state=updateMessage(state,'second',{status:'completed',fileUrl:'https://video/2'});state=updateMessage(state,'first',{status:'failed',error:'failure'});assert.equal(state.messages[0].error,'failure');assert.equal(state.messages[1].fileUrl,'https://video/2')});
test('rejects stale status regressions and permits retry',()=>{assert.equal(canTransition('completed','queued'),false);assert.equal(canTransition('failed','submitting'),true)});
test('limits persisted history to thirty messages',()=>{let state={id:'c',messages:[],updatedAt:0};for(let i=0;i<35;i++)state=appendMessage(state,message(String(i)));assert.equal(state.messages.length,30);assert.equal(state.messages[0].id,'5')});
