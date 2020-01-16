// public/core.js
var scotchTodo = angular.module('scotchTodo', []);

scotchTodo.controller('mainController',($scope, $http) => {
    $scope.formData = {};

    $scope.arlEntered = false;

    // when landing on the page, get all todos and show them
    $http.get('/api/todos')
        .then((response) => {
            $scope.todos = response.data;
            console.log(response.data);
        })

    // when submitting the add form, send the text to the node API
    $scope.createTodo = () => {
        $http.post('/api/todos', $scope.formData)
            .then((response) => {
                $scope.formData = {}; // clear the form so our user is ready to enter another
                $scope.todos = response.data;
                console.log(response.data);
            })
    };

    // when submitting the arl form, send the it to the node API
    $scope.submitArl = () => {
        $http.post('/api/arl', $scope.formData)
            .then((response) => {
                $scope.formData = {}; // clear the form so our user is ready to enter another
                //$scope.todos = data;
                $scope.arlEntered = true;
                console.log(response.data);
            })
            .catch((err) => {
                console.log(err)
            })
    }; 

    // when submitting the add form, send the text to the node API
    $scope.createStream = () => {
        $http.post('/api/stream', $scope.formData)
            .then((response) => {
                $scope.formData = {}; // clear the form so our user is ready to enter another
                //$scope.todos = data;
                console.log(response.data);
            })
    };         

    // delete a todo after checking it
    $scope.deleteTodo = (id) => {
        $http.delete('/api/todos/' + id)
            .then((response) => {
                $scope.todos = response.data;
                console.log(response.data);
            })
    };

});
